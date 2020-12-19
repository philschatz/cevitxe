import A from 'automerge'
import { newid } from '@localfirst/relay-client'
import { ConnectionEvent, ProxyReducer, RepoSnapshot, Snapshot } from '@localfirst/types'
import cuid from 'cuid'
import debug from 'debug'
import { EventEmitter } from 'events'
import { applyMiddleware, createStore, Middleware, Store } from 'redux'
import { composeWithDevTools } from 'redux-devtools-extension'
import { ConnectionManager } from './ConnectionManager'
import { DEFAULT_RELAYS } from './constants'
import { getMiddleware } from './getMiddleware'
import { getReducer } from './getReducer'
import { getKnownDiscoveryKeys } from './keys'
import { Repo } from './Repo'

let log = debug('lf:StoreManager')

const { OPEN, CLOSE, PEER: PEER_ADD, PEER_REMOVE } = ConnectionEvent
/**
 * A StoreManager generates a Redux store with persistence (via the Repo class), networking (via
 * @localfirst/relay-client), and magical synchronization with peers (via automerge)
 */
export class StoreManager<T> extends EventEmitter {
  private databaseName: string
  private proxyReducer: ProxyReducer
  private initialState: Snapshot | RepoSnapshot
  private urls: string[]
  private middlewares: Middleware[] // TODO: accept an `enhancer` object instead
  private repo?: Repo
  private connectionManager?: ConnectionManager
  private collections: string[]
  private log: debug.Debugger

  public store?: Store

  constructor({
    databaseName,
    proxyReducer,
    initialState,
    urls = DEFAULT_RELAYS,
    middlewares = [],
    collections = [],
  }: StoreManagerOptions<T>) {
    super()
    this.proxyReducer = proxyReducer
    this.middlewares = middlewares
    this.initialState = initialState
    this.databaseName = databaseName
    this.urls = urls
    this.collections = collections
    this.log = debug(`lf:storemanager`)
  }

  joinStore = (discoveryKey: string) => this.getStore(discoveryKey, false)
  createStore = (discoveryKey: string) => this.getStore(discoveryKey, true)

  private getStore = async (discoveryKey: string, isCreating: boolean = false) => {
    this.log(`${isCreating ? 'creating' : 'joining'} ${discoveryKey}`)

    const clientId = localStorage.getItem('clientId') || newid()
    localStorage.setItem('clientId', clientId)

    // Create repo for storage
    this.repo = new Repo({
      clientId,
      discoveryKey,
      databaseName: this.databaseName,
      collections: this.collections,
    })

    const state = await this.repo.init(this.initialState, isCreating)
    // Create Redux store to expose to app
    this.store = this.createReduxStore(state)

    // Connect to discovery server to find peers and sync up with them
    this.connectionManager = new ConnectionManager({
      discoveryKey,
      dispatch: this.store.dispatch,
      repo: this.repo,
      urls: this.urls,
    })

    pipeEvents({
      source: this.connectionManager,
      target: this,
      events: [OPEN, CLOSE, PEER_ADD, PEER_REMOVE],
    })

    return this.store
  }

  private createReduxStore(state: RepoSnapshot) {
    if (!this.repo) throw new Error(`Can't create Redux store without repo`)
    // TODO put arguments in the same order (this.proxyReducer, this.repo)
    const reducer = getReducer(this.proxyReducer, this.repo)
    const middleware = getMiddleware(this.repo, this.proxyReducer)
    const enhancer = composeWithDevTools(applyMiddleware(...this.middlewares, middleware))
    return createStore(reducer, state, enhancer)
  }

  public get connectionCount() {
    if (!this.connectionManager) throw new Error('no connectionManager')
    return this.connectionManager.connectionCount
  }

  public get knownDiscoveryKeys() {
    return getKnownDiscoveryKeys(this.databaseName)
  }

  /**
   * Close all connections and the repo's database
   */
  close = async () => {
    this.log('closing')
    if (this.connectionManager) await this.connectionManager.close()
    // if (this.repo) await this.repo.close()

    delete this.repo
    delete this.store
  }
}

export interface StoreManagerOptions<T> {
  /** A proxy reducer that returns a ChangeMap (map of change functions) for each action. */
  proxyReducer: ProxyReducer

  /** Redux middlewares to add to the store. */
  middlewares?: Middleware[]

  /** The starting state of a blank document. */
  initialState: Snapshot | RepoSnapshot

  /** A name for the storage feed, to distinguish this application's data from any other
   * @localfirst/state data stored on the same machine. */
  databaseName: string

  /** The address(es) of one or more relays to try. */
  urls?: string[]

  /** The names of any collections that we need to manage */
  collections?: string[]
}

// Use shorter IDs
A.uuid.setFactory(cuid)

const pipeEvents = ({
  source,
  target,
  events,
}: {
  source: EventEmitter
  target: EventEmitter
  events: ConnectionEvent[]
}) => events.forEach((event) => source.on(event, (payload) => target.emit(event, payload)))
