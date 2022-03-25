#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k'
  }
})

const store = new Corestore('./corestore')
const swarm = new Hyperswarm()

const keys = [].concat(argv.key || [])

swarm.on('connection', function (socket) {
  const p = socket.remotePublicKey.toString('hex')

  console.log('Connection opened', p)
  store.replicate(socket)
  socket.on('error', function (err) {
    console.log(err)
  })
  socket.on('close', function () {
    console.log('Connection closed', p)
  })
})

for (const key of keys) {
  const buf = Buffer.from(key, 'hex')
  const core = store.get(buf)

  core.ready().then(function () {
    console.log('Adding', core)
    const k = core.key.toString('hex')
    swarm.join(core.discoveryKey)
    core.download()
    core.on('download', function (index) {
      console.log('Downloaded block', index, 'from', k)
    })
  })
}

goodbye(() => swarm.destroy())
