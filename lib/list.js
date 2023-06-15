const Id = require('hypercore-id-encoding')
const c = require('compact-encoding')
const Hyperbee = require('hyperbee')
const same = require('same-object')

const types = ['core', 'bee', 'drive']

module.exports = class List {
  constructor (core) {
    this.bee = new Hyperbee(core, { keyEncoding, valueEncoding })
  }

  ready () { return this.bee.ready() }
  close () { return this.bee.close() }

  async put (key, opts = {}) {
    const id = Id.normalize(key)
    if (types.indexOf(opts.type) === -1) throw new Error('Invalid type: ' + opts.type)

    return this.bee.put(id, {
      type: opts.type,
      description: opts.description || '',
      seeders: !!opts.seeders
    }, { cas })
  }

  async update (prev, opts = {}) {
    return this.put(prev.key, Object.assign({}, prev.value, opts))
  }

  async get (key, opts) {
    const id = Id.normalize(key)
    const entry = await this.bee.get(id, opts)
    return entry ? entry.value : entry
  }

  async del (key) {
    const id = Id.normalize(key)
    return this.bee.del(id)
  }

  async * entries (opts = {}) {
    for await (const e of this.bee.createReadStream()) {
      if (opts.type && opts.type !== e.value.type) continue
      yield e
    }
  }
}

function cas (prev, next) {
  return !same(prev.value, next.value, { strict: true })
}

const keyEncoding = {
  preencode (state, k) {
    c.string.fixed(52).preencode(state, k)
  },
  encode (state, k) {
    c.string.fixed(52).encode(state, k)
  },
  decode (state) {
    return c.string.fixed(52).decode(state)
  }
}

const valueEncoding = {
  preencode (state, v) {
    c.string.preencode(state, v.type)
    c.string.preencode(state, v.description)
    c.bool.preencode(state, v.seeders)
  },
  encode (state, v) {
    c.string.encode(state, v.type)
    c.string.encode(state, v.description)
    c.bool.encode(state, v.seeders)
  },
  decode (state) {
    return {
      type: c.string.decode(state),
      description: c.string.decode(state),
      seeders: c.bool.decode(state)
    }
  }
}
