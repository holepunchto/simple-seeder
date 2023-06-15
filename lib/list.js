const Id = require('hypercore-id-encoding')
const c = require('compact-encoding')
const Hyperbee = require('hyperbee')
const ReadyResource = require('ready-resource')

const types = ['core', 'bee', 'drive']

module.exports = class SeedBee extends ReadyResource {
  constructor (core) {
    super()

    this.core = core
    this.bee = new Hyperbee(core, { keyEncoding, valueEncoding })
  }

  _open () {
    return this.bee.ready()
  }

  _close () {
    return this.bee.close()
  }

  async put (key, opts = {}) {
    key = Id.decode(key)
    if (types.indexOf(opts.type) === -1) throw new Error('Invalid type: ' + opts.type)

    return this.bee.put(key, {
      type: opts.type,
      description: opts.description || '',
      seeders: !!opts.seeders
    }, { cas })
  }

  async edit (prev, opts = {}) {
    return this.put(prev.key, Object.assign({}, prev.value, opts))
  }

  async get (key, opts) {
    key = Id.decode(key)
    const entry = await this.bee.get(key, opts)
    return entry ? entry.value : null
  }

  async del (key) {
    key = Id.decode(key)
    return this.bee.del(key) // TODO: cas?
  }

  async * entries (opts = {}) {
    for await (const e of this.bee.createReadStream()) {
      if (opts.type && opts.type !== e.value.type) continue
      yield e
    }
  }
}

function cas (prev, next) {
  if (prev.value.type !== next.value.type) return true
  if (prev.value.description !== next.value.description) return true
  if (prev.value.seeders !== next.value.seeders) return true
  return false
}

const keyEncoding = {
  preencode (state, k) {
    c.fixed32.preencode(state, k)
  },
  encode (state, k) {
    c.fixed32.encode(state, k)
  },
  decode (state) {
    const key = c.fixed32.decode(state)
    return Id.encode(key)
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
