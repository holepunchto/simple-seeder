#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const HypercoreId = require('hypercore-id-encoding')
const Seeders = require('@hyperswarm/seeders')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const fs = require('fs')
const configs = require('tiny-configs')
const crayon = require('tiny-crayon')
const speedometer = require('speedometer')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    bee: 'bee',
    bundle: 'b',
    seeder: 's',
    drive: 'b',
    d: 'b'
  }
})

const tracking = {
  intervalId: null,
  output: '',
  swarm: null,
  cores: [],
  bees: [],
  drives: [],
  seeders: []
}

start().catch(err => {
  console.error(err)
  process.exit()
})

async function start () {
  const secretKey = argv['secret-key']
  const store = new Corestore(argv.storage || './corestore')
  const swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm')
  })

  tracking.swarm = swarm
  update()

  const cores = [].concat(argv.key || [])
  const bees = [].concat(argv.bee || [])
  const drives = [].concat(argv.drive || [])
  const seeders = [].concat(argv.seeder || [])

  if (argv.file) {
    const seeds = await fs.promises.readFile(argv.file)
    for (const [type, key] of configs.parse(seeds, { split: ' ', length: 2 })) {
      if (type === 'key') cores.push(key)
      else if (type === 'bee') bees.push(key)
      else if (type === 'bundle' || type === 'drive') drives.push(key)
      else if (type === 'seeder') seeders.push(key)
      else throw new Error('Invalid seed type: ' + type)
    }
  }

  swarm.on('connection', onsocket)
  swarm.listen()

  for (const key of cores) downloadCore(key)
  for (const key of bees) downloadBee(key)
  for (const key of drives) downloadDrive(key)

  for (const key of seeders) {
    const publicKey = HypercoreId.decode(key)
    const id = HypercoreId.encode(publicKey)
    const keyPair = await store.createKeyPair('simple-seeder-swarm@' + id)
    const sw = new Seeders(publicKey, { dht: swarm.dht, keyPair: keyPair })

    tracking.seeders.push(sw)
    update()

    sw.join()
    sw.on('connection', onsocket)
    // + logs get lost due clear
    // sw.on('update', (record) => console.log('seeder change for ' + key + ':', record)

    goodbye(() => sw.destroy())

    if (!drives.includes(key)) {
      downloadDrive(key, false)
    }
  }

  async function downloadDrive (key, announce) {
    const driveId = HypercoreId.encode(HypercoreId.decode(key))
    const drive = new Hyperdrive(store, HypercoreId.decode(key))
    drive.on('blobs', blobs => downloadCore(blobs.core, false, { track: false }))
    downloadBee(drive.core, announce, { track: false })

    const info = { drive, download: speedometer(), upload: speedometer() }
    drive.core.on('download', () => info.download(1))
    drive.core.on('upload', () => info.upload(1))
    drive.on('blobs', blobs => {
      blobs.core.on('download', () => info.download(1))
      blobs.core.on('upload', () => info.upload(1))
    })
    tracking.drives.push(info)
    update()
  }

  async function downloadBee (core, announce, { track = true } = {}) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

    const bee = new Hyperbee(core)
    await bee.ready()

    downloadCore(core, announce, { track, isBee: true })

    if (track) {
      const info = { bee, download: speedometer(), upload: speedometer() }
      core.on('download', () => info.download(1))
      core.on('upload', () => info.upload(1))
      tracking.bees.push(info)
      update()
    }
  }

  async function downloadCore (core, announce, { track = true, isBee = false } = {}) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

    if (track && !isBee) {
      const info = { core, download: speedometer(), upload: speedometer() }
      core.on('download', () => info.download(1))
      core.on('upload', () => info.upload(1))
      tracking.cores.push(info)
      update()
    }

    await core.ready()
    if (announce !== false) swarm.join(core.discoveryKey)
    core.download({ linear: true })
  }

  goodbye(() => swarm.destroy())

  function onsocket (socket) {
    const remoteInfo = socket.rawStream.remoteHost + ':' + socket.rawStream.remotePort
    const id = HypercoreId.encode(socket.remotePublicKey)

    // + error logs get lost due clear
    socket.on('error', (err) => console.log(err))
    store.replicate(socket)
  }

  tracking.intervalId = setInterval(update, 5000)
  update()
}

function update () {
  const { swarm, seeders, cores, bees, drives } = tracking
  const { dht } = swarm

  if (!dht || !dht.bootstrapped) return

  let output = ''
  const print = (...args) => output += args.join(' ') + '\n'

  print('Node')
  print('- Address:', crayon.yellow(dht.host + ':' + dht.port))
  print('- Firewalled?', dht.firewalled ? crayon.red('Yes') : crayon.green('No'))
  print('- NAT type:', dht.port ? crayon.green('Consistent') : crayon.red('Random'))
  print()

  print('Swarm')
  print('- Public key:', crayon.magenta(HypercoreId.encode(swarm.keyPair.publicKey)))
  print('- Connections:', crayon.yellow(swarm.connections.size), swarm.connecting ? ('(connecting ' + crayon.yellow(swarm.connecting) + ')') : '')
  // + more info
  print()

  print('Seeders')
  for (const seeder of seeders) {
    print('-', HypercoreId.encode(seeder.keyPair.publicKey))
    // + more info
  }
  print()

  print('Cores')
  for (const { core, download, upload } of cores) {
    if (!core.opened) continue

    print(
      '-',
      crayon.magenta(core.id),
      crayon.yellow(core.contiguousLength + '/' + core.length),
      crayon.blueBright('peers ' + core.peers.length),
      crayon.green('dl ' + Math.ceil(download()) + ' blk/s'),
      crayon.cyan('up ' + Math.ceil(upload()) + ' blk/s')
    )
  }
  print()

  print('Bees')
  for (const { bee, download, upload } of bees) {
    const { core } = bee
    if (!core.opened) continue

    print(
      '-',
      crayon.magenta(core.id),
      crayon.yellow(core.contiguousLength + '/' + core.length),
      crayon.blueBright('peers ' + core.peers.length),
      crayon.green('dl ' + Math.ceil(download()) + ' blk/s'),
      crayon.cyan('up ' + Math.ceil(upload()) + ' blk/s')
    )
  }
  print()

  print('Drives')
  for (const { drive, download, upload } of drives) {
    if (!drive.opened || !drive.blobs) continue

    const id = HypercoreId.encode(drive.key)
    const filesProgress = drive.core.contiguousLength + '/' + drive.core.length
    const blobsProgress = drive.blobs.core.contiguousLength + '/' + drive.blobs.core.length
    const peers = drive.core.peers.length + drive.blobs.core.peers.length

    print(
      '-',
      crayon.magenta(id),
      crayon.yellow(filesProgress) + ', ' + crayon.yellow(blobsProgress),
      crayon.blueBright('peers ' + peers),
      crayon.green('dl ' + Math.ceil(download()) + ' blk/s'),
      crayon.cyan('up ' + Math.ceil(upload()) + ' blk/s')
    )
  }
  print()

  if (output === tracking.output) return
  tracking.output = output

  console.clear()
  console.log(output)
}
