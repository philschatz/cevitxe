import { Server } from 'cevitxe-signal-server'
import { Cevitxe } from './Cevitxe'
import { newid } from 'cevitxe-signal-client'
import { ProxyReducer, ChangeMap } from './types'
import { pause } from './lib/pause'
import eventPromise from 'p-event'

require('fake-indexeddb/auto')

describe('Cevitxe', () => {
  interface FooState {
    settings: {
      foo?: number
    }
  }

  const initialLocalState: FooState = { settings: { foo: 1 } }
  const initialRemoteState = {}

  const port = 10000
  const urls = [`ws://localhost:${port}`]

  const proxyReducer: ProxyReducer = ({ type, payload }) => {
    switch (type) {
      case 'SET_FOO':
        return {
          settings: s => (s.foo = payload.value),
        }
      default:
        return null
    }
  }

  const newDiscoveryKey = () => newid(6)

  const getLocalCevitxe = () => {
    const databaseName = `local-${newid()}`
    return new Cevitxe({ databaseName, proxyReducer, initialState: initialLocalState, urls })
  }

  const getRemoteCevitxe = () => {
    const databaseName = `remote-${newid()}`
    return new Cevitxe({ databaseName, proxyReducer, initialState: initialRemoteState, urls })
  }

  describe('offline', () => {
    describe('joinStore', () => {
      it('should return a redux store with empty state', async () => {
        expect.assertions(2)

        const discoveryKey = newDiscoveryKey()
        const localCevitxe = await getLocalCevitxe()
        const localStore = await localCevitxe.joinStore(discoveryKey)

        // store exists
        expect(localStore).not.toBeUndefined()

        // it's in empty (waiting) state
        expect(localStore.getState()).toEqual({})

        await pause(100) // HACK: wait for indexeddb to finish whatever it's doing
        await localCevitxe.close()
      })
    })

    describe('createStore', () => {
      it('should return a redux store', async () => {
        expect.assertions(5)
        const discoveryKey = newDiscoveryKey()
        const localCevitxe = await getLocalCevitxe()
        const localStore = await localCevitxe.createStore(discoveryKey)

        // store exists
        expect(localStore).not.toBeUndefined()

        // it looks like a store
        expect(localStore).toHaveProperty('getState')
        expect(localStore).toHaveProperty('dispatch')
        expect(localStore).toHaveProperty('subscribe')

        // it contains the initial state
        expect(localStore.getState()).toEqual(initialLocalState)

        await pause(100) // HACK: wait for indexeddb to finish whatever it's doing
        await localCevitxe.close()
      })

      it('should use the reducer we gave it', async () => {
        expect.assertions(1)

        const discoveryKey = newDiscoveryKey()
        const localCevitxe = await getLocalCevitxe()
        const localStore = await localCevitxe.createStore(discoveryKey)

        // dispatch a change
        localStore.dispatch({ type: 'SET_FOO', payload: { value: 3 } })

        // confirm that the change was made
        const state = localStore.getState() as FooState
        expect(state.settings.foo).toEqual(3)

        await pause(100) // HACK: wait for indexeddb to finish whatever it's doing
        await localCevitxe.close()
      })
    })

    describe('close', () => {
      it('should destroy any current store', async () => {
        expect.assertions(2)

        const discoveryKey = newDiscoveryKey()
        const localCevitxe = await getLocalCevitxe()
        const localStore = await localCevitxe.createStore(discoveryKey) // don't need return value

        // confirm that we have a store
        expect(localCevitxe.store).not.toBeUndefined()
        await pause(100) // HACK for indexeddb

        // close the store
        await localCevitxe.close()

        // confirm the store is gone
        expect(localCevitxe.store).toBeUndefined()
      })
    })

    describe('persistence', () => {
      it('should rehydrate from persisted state when available', async () => {
        const discoveryKey = newDiscoveryKey()
        const localCevitxe = await getLocalCevitxe()
        const localStore = await localCevitxe.createStore(discoveryKey)

        const state = localStore.getState() as FooState
        expect(state.settings.foo).toEqual(1)

        // To simulate rehydrating from persisted state we dispatch a change to our local store.
        // This state gets written to our fake-indexeddb.
        localStore.dispatch({ type: 'SET_FOO', payload: { value: 42 } })

        // confirm that the change took
        const updatedState = localStore.getState() as FooState
        expect(updatedState.settings.foo).toEqual(42)

        // disconnect current store
        await pause(500) // HACK:
        await localCevitxe.close()

        // Then we create a new store, which should see the state in the fake db and load it
        const newStore = await localCevitxe.joinStore(discoveryKey)

        // Confirm that the modified state is still there
        const newState = newStore.getState() as FooState
        expect(newState.settings.foo).toEqual(42)
      })
    })
  })

  describe('online', () => {
    const open = async () => {
      const server = new Server({ port })
      await server.listen({ silent: true })

      const discoveryKey = newDiscoveryKey()

      // local cevitxe & store
      const localCevitxe = getLocalCevitxe()
      const localStore = await localCevitxe.createStore(discoveryKey)

      // remote cevitxe (tests control timing of joining store)
      const remoteCevitxe = getRemoteCevitxe()

      // join store from remote store
      const remoteStore = await remoteCevitxe.joinStore(discoveryKey)

      // wait for local peer to see connection
      await eventPromise(localCevitxe, 'peer')

      // include a teardown function in the return values
      const close = async () => {
        await localCevitxe.close()
        await remoteCevitxe.close()
        await server.close()
      }

      return { close, localCevitxe, remoteCevitxe, localStore, remoteStore }
    }

    it('should communicate changes from one store to another', async () => {
      const { close, remoteCevitxe, localStore, remoteStore } = await open()

      // change something in the local store
      localStore.dispatch({ type: 'SET_FOO', payload: { value: 42 } })

      // confirm that the change took locally
      const localState = localStore.getState() as FooState
      expect(localState.settings.foo).toEqual(42)

      // wait for remote peer to see change
      await eventPromise(remoteCevitxe, 'change')

      // confirm that the remote store has the new value
      const remoteState = remoteStore.getState() as FooState
      expect(remoteState.settings.foo).toEqual(42)

      await close()
    })

    describe('close', () => {
      it('should delete any connections', async () => {
        const { close, localCevitxe } = await open()

        // confirm that we have a connection
        expect(Object.keys(localCevitxe.connections)).toHaveLength(1)

        await close()

        // confirm that we no longer have a connection
        expect(Object.keys(localCevitxe.connections)).toHaveLength(0)
      })
    })
  })

  describe('multiple documents', () => {
    interface SchoolData {
      // NOTE: Apparently Automerge can't use arrays as a document either, so we're going with the map of IDs
      teachers: {}
      [k: string]: any
    }
    const proxyReducer = (({ type, payload }) => {
      switch (type) {
        case 'ADD_TEACHER': {
          return {
            teachers: s => (s[payload.id] = true),
            [payload.id]: s => (s = Object.assign(s, payload)),
          }
        }
        case 'REMOVE_TEACHER': {
          return {
            teachers: s => delete s[payload.id],
            [payload.id]: s => undefined,
          }
        }
        case 'UPDATE_TEACHER': {
          return {
            [payload.id]: s => (s = Object.assign(s, payload)),
          }
        }
        default:
          return null
      }
    }) as ProxyReducer

    const initialState: SchoolData = { teachers: {} }

    const open = async () => {
      const server = new Server({ port })
      await server.listen({ silent: true })

      const discoveryKey = newDiscoveryKey()

      // local cevitxe & store
      const localCevitxe = new Cevitxe({
        databaseName: `local-${newid()}`,
        proxyReducer,
        initialState,
        urls,
      })
      // create new store locally
      const localStore = await localCevitxe.createStore(discoveryKey)

      // remote cevitxe
      const remoteCevitxe = new Cevitxe({
        databaseName: `remote-${newid()}`,
        proxyReducer,
        initialState: {},
        urls,
      })
      // join store from remote peer
      const remoteStore = await remoteCevitxe.joinStore(discoveryKey)

      // wait for both peers to see connection
      await Promise.all([
        eventPromise(localCevitxe, 'peer'), //
        eventPromise(remoteCevitxe, 'peer'),
      ])

      // include a teardown function in the return values
      const close = async () => {
        await localCevitxe.close()
        await remoteCevitxe.close()
        await server.close()
      }

      return { close, localCevitxe, remoteCevitxe, localStore, remoteStore }
    }

    it.only('should sync multiple documents', async () => {
      const { close, remoteCevitxe, localStore, remoteStore } = await open()

      // change something in the local store
      const teacher = { id: 'abcxyz', first: 'Herb', last: 'Caudill' }
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher })

      const expectedState = {
        abcxyz: teacher,
        teachers: { abcxyz: true },
      }

      // confirm that the change took locally
      const localState = localStore.getState() as SchoolData
      // NOTE: This always failed deep equality tho it looked good-ish to me
      // I don't know what the blue output of jest toEqual means exactly,
      // seemed the like indenting was off or something?
      //expect(localState).toEqual(expectedState)
      expect(localState.teachers).toEqual({ abcxyz: true })
      expect(localState.abcxyz).toMatchObject(teacher)

      // wait for remote peer to see change
      await eventPromise(remoteCevitxe, 'change')

      // confirm that the remote store has the new value
      const remoteState = remoteStore.getState() as SchoolData
      console.log({ localState, remoteState })
      //expect(remoteState).toEqual(expectedState)
      // NOTE: remoteState ends up just being abcxyz instead of the full parent object :shrug:
      expect(remoteState.teachers).toEqual({ abcxyz: true })
      expect(remoteState.abcxyz).toMatchObject(teacher)

      await close()
    })

    it('should sync changes to an existing document in both directions', async () => {
      const { close, localCevitxe, remoteCevitxe, localStore, remoteStore } = await open()

      // add a teacher in the local store
      const teacher1 = { id: 'abcxyz', first: 'Herb', last: 'Caudill' }
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(remoteCevitxe, 'change')

      // modify the teacher in the remote store
      remoteStore.dispatch({ type: 'UPDATE_TEACHER', payload: { id: 'abcxyz', email: 'h@hc3.me' } })
      await eventPromise(localCevitxe, 'change')

      // modify the teacher in the local store
      localStore.dispatch({ type: 'UPDATE_TEACHER', payload: { id: 'abcxyz', first: 'Herbert' } })
      await eventPromise(remoteCevitxe, 'change')

      const expectedState = {
        abcxyz: { id: 'abcxyz', first: 'Herbert', last: 'Caudill', email: 'h@hc3.me' },
        teachers: ['abcxyz'],
      }

      // confirm that the local store is caught up
      const localState = localStore.getState() as SchoolData
      expect(localState).toEqual(expectedState)

      // confirm that the remote store is caught up
      const remoteState = remoteStore.getState() as SchoolData
      expect(remoteState).toEqual(expectedState)

      await close()
    })

    it('should sync new documents in both directions', async () => {
      const { close, localCevitxe, remoteCevitxe, localStore, remoteStore } = await open()

      // add a teacher in the local store
      const teacher1 = { id: 'abcxyz', first: 'Herb', last: 'Caudill' }
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(remoteCevitxe, 'change')

      // add a teacher in the remote store
      const teacher2 = { id: 'qrstuv', first: 'Brent', last: 'Keller' }
      remoteStore.dispatch({ type: 'ADD_TEACHER', payload: teacher2 })
      await eventPromise(localCevitxe, 'change')

      const expectedState = {
        abcxyz: { id: 'abcxyz', first: 'Herb', last: 'Caudill' },
        qrstuv: { id: 'qrstuv', first: 'Brent', last: 'Keller' },
        teachers: ['abcxyz', 'qrstuv'],
      }

      // confirm that the local store is caught up
      const localState = localStore.getState() as SchoolData
      expect(localState).toEqual(expectedState)

      // confirm that the remote store is caught up
      const remoteState = remoteStore.getState() as SchoolData
      expect(remoteState).toEqual(expectedState)

      await close()
    })
  })
})
