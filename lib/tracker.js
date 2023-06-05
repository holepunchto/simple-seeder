const speedometer = require('speedometer')

module.exports = class Tracker {
  constructor () {
    this.resources = []
  }

  add (type, resource, opts) {
    const info = {
      type,
      [type]: resource,
      resource,
      watcher: opts.watcher || null,
      blocks: { download: speedometer(), upload: speedometer() },
      network: { download: speedometer(), upload: speedometer() }
    }

    if (opts && opts.speedometer) Tracker.speedometer(opts.speedometer, info)

    this.resources.push(info)

    return info
  }

  getByType (type) {
    return this.resources.filter(r => r.type === type)
  }

  static speedometer (core, info) {
    core.on('download', onspeed.bind(null, 'download', info))
    core.on('upload', onspeed.bind(null, 'upload', info))
  }
}

function onspeed (eventName, info, index, byteLength, from) {
  info.blocks[eventName](1)
  info.network[eventName](byteLength)
}
