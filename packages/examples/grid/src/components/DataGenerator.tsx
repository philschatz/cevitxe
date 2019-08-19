/** @jsx jsx */
import { jsx } from '@emotion/core'
import { menu, styles } from 'cevitxe-toolbar'
import { debug } from 'debug'
import faker from 'faker'
import { useState } from 'react'
import { useDispatch } from 'react-redux'
import { clearCollection, loadCollection, loadSchema } from 'src/redux/actions'
import uuid from 'uuid'
import { JSONSchema7 } from 'json-schema'

const pause = (t: number) => new Promise(ok => setTimeout(ok, t))

const log = debug('cevitxe:grid:datagenerator')

export function DataGenerator() {
  const dispatch = useDispatch()
  const [menuOpen, setMenuOpen] = useState(false)
  const [progress, setProgress] = useState(0)

  const toggleMenu = () => setTimeout(() => setMenuOpen(!menuOpen))
  const hideMenu = () => setTimeout(() => setMenuOpen(false), 500)
  const schema = {
    type: 'object',
    properties: {
      name: {},
      email: { format: 'email' },
      age: { type: 'number' },
      street: {},
      city: {},
      state: {},
      zip: {},
      gender: {},
      latitude: {},
      longitude: {},
      paragraph: {},
    },
  } as JSONSchema7

  const generate = async (rows: number) => {
    setProgress(0)
    dispatch(clearCollection())
    dispatch(loadSchema(schema))
    const collection = {} as any
    log('generate: starting', rows)

    for (let i = 0; i < rows; i++) {
      const item = {
        id: uuid(),
        name: faker.name.findName(),
        email: faker.internet.email(),
        age: faker.random.number({ min: 18, max: 100 }),
        street: faker.address.streetAddress(),
        city: faker.address.city(),
        state: faker.address.state(),
        zip: faker.address.zipCode(),
        gender: faker.random.arrayElement(['Male', 'Female']),
        latitude: +faker.address.latitude(),
        longitude: +faker.address.longitude(),
        paragraph: faker.lorem.paragraph(),
      }
      collection[item.id] = item
      const p = Math.ceil((i / rows) * 100)
      await pause(0)
      setProgress(p)
    }
    log('generate: done', rows)
    dispatch(loadCollection(collection))
    await pause(0)
    setProgress(0)
  }

  return (
    <div css={styles.toolbarGroup}>
      <div css={styles.menuWrapper}>
        <button
          role="button"
          type="button"
          onFocus={toggleMenu}
          onBlur={hideMenu}
          css={styles.button}
          disabled={progress > 0}
        >
          {progress ? 'Generating...' : 'Generate data'}
        </button>
        <div css={menu(menuOpen)}>
          {[100, 1000, 10000, 100000].map(rows => (
            <button
              key={rows}
              css={styles.menuItem}
              role="button"
              type="button"
              disabled={progress > 0}
              onClick={() => {
                generate(rows)
              }}
            >
              {rows} rows
            </button>
          ))}
        </div>
      </div>
      {progress > 0 && <label>{`${progress}%`}</label>}
    </div>
  )
}
