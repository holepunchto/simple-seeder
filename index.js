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
const byteSize = require('tiny-byte-size')
const DHT = require('hyperdht')
const menu = require('./menu.js')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    core: 'c',
    bee: 'b',
    drive: 'd',
    seeder: 's'
    list: 'l'
  }
})

const tracking = {
  intervalId: null,
  output: '',
  notifs: {},
  swarm: null,
  lists: [],
  cores: [],
  bees: [],
  drives: [],
  seeders: []
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})

async function start () {
  const secretKey = argv['secret-key']
  const store = new Corestore(argv.storage || './corestore')
  const port = argv.port

  if (argv.menu) {
    menu(argv.menu, { store })
    return
  }

  const dht = new DHT({ port })
  const swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm'),
    dht
  })

  tracking.swarm = swarm

  swarm.on('connection', onsocket)
  swarm.listen()

  const lists = [].concat(argv.list || [])
  const cores = [].concat(argv.core || argv.key || [])
  const bees = [].concat(argv.bee || [])
  const drives = [].concat(argv.drive || [])
  const seeders = [].concat(argv.seeder || [])

  if (argv.file) {
    const file = await fs.promises.readFile(argv.file)
    const list = configs.parse(file, { split: ' ', length: 2 })

    for (const [type, key] of list) {

      // TODO: simplify
      if (type === 'list') lists.push(key)
      else if (type === 'core' || type === 'key') cores.push(key)
      else if (type === 'bee') bees.push(key)
      else if (type === 'drive') drives.push(key)
      else if (type === 'seeder') seeders.push(key)
      else throw new Error('Invalid seed type: ' + type + ' for ' + key)
    }
  }

  for (const key of lists) {
    const bee = await downloadLists(key)

    if (argv['dry-run']) continue

    for (const type of ['core', 'bee', 'drive', 'seeder']) {
      const list = bee.sub(type, { keyEncoding: 'utf-8', valueEncoding: 'json' })

      for await (const entry of list.createReadStream()) {
        // TODO: simplify
        if (type === 'core') cores.push(entry.key)
        else if (type === 'bee') bees.push(entry.key)
        else if (type === 'drive') drives.push(entry.key)
        else if (type === 'seeder') seeders.push(entry.key)
        else throw new Error('Invalid seed type: ' + type + ' for ' + entry.key)
      }
    }
  }

  // TODO: dedup keys, in case having too many external lists where there are more chances to repeat resources

  for (const key of cores) await downloadCore(key)
  for (const key of bees) await downloadBee(key)
  for (const key of drives) await downloadDrive(key)

  for (const key of seeders) {
    const publicKey = HypercoreId.decode(key)
    const id = HypercoreId.encode(publicKey)
    const keyPair = await store.createKeyPair('simple-seeder-swarm@' + id)
    const sw = new Seeders(publicKey, { dht: swarm.dht, keyPair })

    tracking.seeders.push(sw)

    sw.join()
    sw.on('connection', onsocket)
    sw.on('update', function (record) {
      tracking.notifs[id] = record
    })

    goodbye(() => sw.destroy())

    if (!drives.includes(key)) {
      await downloadDrive(key, false)
    }
  }

  async function downloadLists (core, announce, { track = true } = {}) {
    const bee = await downloadBee(core, announce, { track: false })

    if (track) {
      // TODO: reuse info + onspeed maker
      const info = { bee, blocks: { download: speedometer(), upload: speedometer() }, network: { download: speedometer(), upload: speedometer() } }
      bee.core.on('download', onspeed.bind(null, 'download', info))
      bee.core.on('upload', onspeed.bind(null, 'upload', info))
      tracking.lists.push(info)
    }

    return bee
  }

  async function downloadDrive (key, announce) {
    const drive = new Hyperdrive(store, HypercoreId.decode(key))

    drive.on('blobs', blobs => downloadCore(blobs.core, false, { track: false }))
    downloadBee(drive.core, announce, { track: false })

    const info = { drive, blocks: { download: speedometer(), upload: speedometer() }, network: { download: speedometer(), upload: speedometer() } }
    drive.core.on('download', onspeed.bind(null, 'download', info))
    drive.core.on('upload', onspeed.bind(null, 'upload', info))
    drive.on('blobs', blobs => {
      blobs.core.on('download', onspeed.bind(null, 'download', info))
      blobs.core.on('upload', onspeed.bind(null, 'upload', info))
    })

    await drive.ready()
    tracking.drives.push(info)
  }

  async function downloadBee (core, announce, { track = true } = {}) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

    const bee = new Hyperbee(core)
    await bee.ready()

    if (track) {
      const info = { bee, blocks: { download: speedometer(), upload: speedometer() }, network: { download: speedometer(), upload: speedometer() } }
      core.on('download', onspeed.bind(null, 'download', info))
      core.on('upload', onspeed.bind(null, 'upload', info))
      tracking.bees.push(info)
    }

    await downloadCore(core, announce, { track: false })

    return bee
  }

  async function downloadCore (core, announce, { track = true } = {}) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

    await core.ready()

    if (track) {
      const info = { core, blocks: { download: speedometer(), upload: speedometer() }, network: { download: speedometer(), upload: speedometer() } }
      core.on('download', onspeed.bind(null, 'download', info))
      core.on('upload', onspeed.bind(null, 'upload', info))
      tracking.cores.push(info)
    }

    if (announce !== false) {
      const done = core.findingPeers()
      swarm.join(core.discoveryKey, { client: true, server: !argv.backup })
      swarm.flush().then(done, done)
    }

    core.download()
  }

  goodbye(() => swarm.destroy())

  function onsocket (socket) {
    socket.on('error', noop)
    store.replicate(socket)
  }

  tracking.intervalId = setInterval(update, argv.i || 5000)
  update()
}

function update () {
  const { swarm, lists, seeders, cores, bees, drives } = tracking
  const { dht } = swarm

  let output = ''
  const print = (...args) => { output += args.join(' ') + '\n' }

  print('Node')
  print('- Address:', dht.bootstrapped ? crayon.yellow(dht.host + ':' + dht.port) : crayon.gray('~'))
  print('- Firewalled?', dht.bootstrapped ? (dht.firewalled ? crayon.red('Yes') : crayon.green('No')) : crayon.gray('~'))
  print('- NAT type:', dht.bootstrapped ? (dht.port ? crayon.green('Consistent') : crayon.red('Random')) : crayon.gray('~'))
  print()

  print('Swarm')
  print('- Public key:', crayon.green(HypercoreId.encode(swarm.keyPair.publicKey)))
  print('- Connections:', crayon.yellow(swarm.connections.size), swarm.connecting ? ('(connecting ' + crayon.yellow(swarm.connecting) + ')') : '')
  print()

  if (lists.length) {
    print('Lists')
    for (const { bee, blocks, network } of lists) {
      const { core } = bee

      // TODO: reuse
      print(
        '-',
        crayon.green(core.id),
        crayon.yellow(core.contiguousLength + '/' + core.length) + ' blks,',
        crayon.yellow(core.peers.length) + ' peers,',
        crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.upload())) + ' blks/s',
        crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.upload()))
      )
    }
    print()
  }

  if (seeders.length) {
    print('Seeders')
    for (const sw of seeders) {
      const seedId = HypercoreId.encode(sw.seedKeyPair.publicKey)
      const notif = tracking.notifs[seedId]

      if (!notif) {
        print('-', crayon.green(seedId), crayon.gray('~'))
        continue
      }

      print(
        '-',
        crayon.green(seedId),
        crayon.yellow(notif.seeds.length) + ' seeds,',
        crayon.yellow(notif.core.length) + ' length,',
        crayon.yellow(notif.core.fork) + ' fork'
      )
    }
    print()
  }

  if (cores.length) {
    print('Cores')
    for (const { core, blocks, network } of cores) {
      print(
        '-',
        crayon.green(core.id),
        crayon.yellow(core.contiguousLength + '/' + core.length) + ' blks,',
        crayon.yellow(byteSize(core.byteLength) + ','),
        crayon.yellow(core.peers.length) + ' peers,',
        crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.upload())) + ' blks/s',
        crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.upload()))
      )
    }
    print()
  }

  if (bees.length) {
    print('Bees')
    for (const { bee, blocks, network } of bees) {
      const { core } = bee

      print(
        '-',
        crayon.green(core.id),
        crayon.yellow(core.contiguousLength + '/' + core.length) + ' blks,',
        crayon.yellow(byteSize(core.byteLength) + ','),
        crayon.yellow(core.peers.length) + ' peers,',
        crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.upload())) + ' blks/s',
        crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.upload()))
      )
    }
    print()
  }

  if (drives.length) {
    print('Drives')
    for (const { drive, blocks, network } of drives) {
      const id = HypercoreId.encode(drive.key)
      const filesProgress = drive.core.contiguousLength + '/' + drive.core.length
      const blobsProgress = (drive.blobs?.core.contiguousLength || 0) + '/' + (drive.blobs?.core.length || 0)
      const blobsBytes = drive.blobs?.core.byteLength || 0
      print(
        '-',
        crayon.green(id),
        crayon.yellow(filesProgress) + ' + ' + crayon.yellow(blobsProgress) + ' blks,',
        crayon.yellow(byteSize(blobsBytes) + ','),
        crayon.yellow(drive.core.peers.length) + ' + ' + crayon.yellow(drive.blobs?.core.peers.length || 0) + ' peers,',
        crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.upload())) + ' blks/s',
        crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.download())),
        crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.upload()))
      )
    }
    print()
  }

  if (output === tracking.output) return
  tracking.output = output

  console.clear()
  process.stdout.write(output)
}

function onspeed (eventName, info, index, byteLength, from) {
  info.blocks[eventName](1)
  info.network[eventName](byteLength)
}

function noop () {}
