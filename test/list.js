const test = require('brittle')
const RAM = require('random-access-memory')
const Hypercore = require('hypercore')
const List = require('../lib/list.js')

const K = 'fbh6h7j9xgpsqeyke9rtzbcyowwobxfozhr3ukz9x64kf9zok41o'

test('basic', async function (t) {
  t.plan(5)

  const list = new List(new Hypercore(RAM))
  await list.ready()

  t.ok(list.bee)

  await list.put(K, { type: 'core' })

  t.alike(await list.get(K), {
    type: 'core',
    description: '',
    seeders: false
  })

  let entry = null
  for await (const e of list.entries()) { // eslint-disable-line no-unreachable-loop
    entry = e
    break
  }

  t.alike(entry, {
    seq: 1,
    key: K,
    value: {
      type: 'core',
      description: '',
      seeders: false
    }
  })

  await list.update(entry, { description: 'Some text' })

  t.alike(await list.get(K), {
    type: 'core',
    description: 'Some text',
    seeders: false
  })

  await list.del(K)

  t.is(await list.get(K), null)

  await list.close()
})

test('try to repeat the same entry', async function (t) {
  t.plan(5)

  const list = new List(new Hypercore(RAM))
  t.is(list.bee.version, 1)

  await list.put(K, { type: 'core' })
  t.is(list.bee.version, 2)

  await list.put(K, { type: 'core' })
  t.is(list.bee.version, 2)

  await list.put(K, { type: 'core', description: 'Updated' })
  t.is(list.bee.version, 3)

  await list.put(K, { type: 'core', description: 'Updated' })
  t.is(list.bee.version, 3)
})

test('invalid key', async function (t) {
  t.plan(1)

  const list = new List(new Hypercore(RAM))

  try {
    await list.put('random-invalid-key')
  } catch (err) {
    t.is(err.message, 'Invalid Hypercore key')
  }
})

test('empty or invalid type', async function (t) {
  t.plan(2)

  const list = new List(new Hypercore(RAM))

  try {
    await list.put(K)
  } catch (err) {
    t.ok(err.message.startsWith('Invalid type'))
  }

  try {
    await list.put(K, { type: 'seeders' })
  } catch (err) {
    t.ok(err.message.startsWith('Invalid type'))
  }
})

test('invalid encoding values', async function (t) {
  t.plan(1)

  const list = new List(new Hypercore(RAM))

  try {
    await list.put(K, { type: 'core', description: 123 })
  } catch (err) {
    t.is(err.code, 'ERR_INVALID_ARG_TYPE') // CompactEncoding error
  }
})
