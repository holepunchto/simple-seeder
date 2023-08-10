#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const crayon = require('tiny-crayon')
const byteSize = require('tiny-byte-size')
const DHT = require('hyperdht')
const debounceify = require('debounceify')
const load = require('./lib/load.js')
const SimpleSeeder = require('./lib/simple-seeder.js')
const b4a = require('b4a')

const argv = minimist(process.argv.slice(2), {
  alias: {
    core: 'c',
    bee: 'b',
    drive: 'd',
    seeders: 's'
  }
})

const secretKey = argv['secret-key']
const store = new Corestore(argv.storage || './corestore')

const dryRun = argv['dry-run']
const quiet = argv.quiet

let swarm = null
let tracker = null
let stdout = ''

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm'),
    dht: new DHT({ port: argv.port }),
    firewall
  })
  swarm.on('connection', onsocket)
  swarm.listen()
  goodbye(() => swarm.destroy(), 1)

  if (argv.menu) {
    const menu = require('./menu.js')
    await menu(argv.menu, { store, swarm })
    console.log('Closing')
    goodbye.exit()
    return
  }

  const seeds = await load(argv)

  tracker = new SimpleSeeder(store, swarm, { backup: argv.backup, onupdate: ui })
  goodbye(() => tracker.destroy())

  for (const { key, type } of seeds) {
    if (type === 'seeders' && seeds.find(s => s.type === 'drive' && s.key === key)) continue
    const seeders = !!(type === 'drive' && seeds.find(s => s.type === 'seeders' && s.key === key))

    await tracker.add(key, { type, seeders })
  }

  setInterval(ui, argv.i || 5000)
  ui()

  const lists = tracker.filter(r => r.type === 'list')
  if (lists[0] && !dryRun) {
    const info = lists[0]
    const bound = tracker.update.bind(tracker, info, info.instance)
    const debounced = debounceify(bound)
    info.instance.core.on('append', debounced)
    await debounced()
  }
}

function ui () {
  let output = ''
  const print = (...args) => { output += args.join(' ') + '\n' }
  const flush = () => {
    if (output === stdout) return
    stdout = output
    if (!quiet) console.clear()
    process.stdout.write(output)
  }

  const { dht } = swarm
  const cores = tracker.filter(r => r.type === 'core')
  const bees = tracker.filter(r => r.type === 'bee')
  const drives = tracker.filter(r => r.type === 'drive')
  const seeders = tracker.filter(r => !!r.seeders)
  const lists = tracker.filter(r => r.type === 'list')

  const totalConnections = swarm.connections.size + seeders.reduce((acc, r) => acc + r.seeders.connections.length, 0)
  const totalConnecting = swarm.connecting + seeders.reduce((acc, r) => acc + r.seeders.clientConnecting, 0)

  if (quiet) {
    print('Swarm connections:', crayon.yellow(totalConnections), totalConnecting ? ('(connecting ' + crayon.yellow(totalConnecting) + ')') : '')
    flush()
    return
  }

  print('Node')
  print('- Address:', dht.bootstrapped ? crayon.yellow(dht.host + ':' + dht.port) : crayon.gray('~'))
  print('- Firewalled?', dht.bootstrapped ? (dht.firewalled ? crayon.red('Yes') : crayon.green('No')) : crayon.gray('~'))
  print('- NAT type:', dht.bootstrapped ? (dht.port ? crayon.green('Consistent') : crayon.red('Random')) : crayon.gray('~'))
  print()

  print('Swarm')
  print('- Public key:', crayon.green(HypercoreId.encode(swarm.keyPair.publicKey)))
  print('- Connections:', crayon.yellow(totalConnections), totalConnecting ? ('(connecting ' + crayon.yellow(totalConnecting) + ')') : '')
  print()

  if (lists.length) {
    print('Lists')
    for (const { instance: bee, blocks, network } of lists) {
      // TODO: disable byte size?
      output += formatResource(bee.core, null, { blocks, network })
    }
    print()
  }

  if (seeders.length) {
    print('Seeders')
    for (const { seeders: sw } of seeders) {
      const seedId = HypercoreId.encode(sw.seedKeyPair.publicKey)

      if (!sw.seeder) {
        print('-', crayon.green(seedId), crayon.gray('~'))
        continue
      }

      print(
        '-',
        crayon.green(seedId),
        crayon.yellow(sw.seeds.length) + ' seeds,',
        crayon.yellow(sw.core.length) + ' length,',
        crayon.yellow(sw.core.fork) + ' fork'
      )
    }
    print()
  }

  if (cores.length) {
    print('Cores')
    for (const { instance: core, blocks, network } of cores) {
      output += formatResource(core, null, { blocks, network })
    }
    print()
  }

  if (bees.length) {
    print('Bees')
    for (const { instance: bee, blocks, network } of bees) {
      output += formatResource(bee.core, null, { blocks, network })
    }
    print()
  }

  if (drives.length) {
    print('Drives')
    for (const { instance: drive, blocks, network } of drives) {
      output += formatResource(drive.core, drive.blobs, { blocks, network, isDrive: true })
    }
    print()
  }

  flush()
}

function firewall (remotePublicKey) {
  const [list] = tracker.filter(r => r.type === 'list')
  if (!list) return false

  if (list.userData.allowedPeers === null) { // all peers allowed
    return false
  }

  if (list.userData.allowedPeers.length === 0) { // none allowed
    return true
  }

  const hexKey = b4a.toString(remotePublicKey, 'hex')
  return list.userData.allowedPeers.indexOf(hexKey) === -1 // check if it is allowed
}

function formatResource (core, blobs, { blocks, network, isDrive = false } = {}) {
  const progress = [crayon.yellow(core.contiguousLength + '/' + core.length)]
  if (isDrive) progress.push(crayon.yellow((blobs?.core.contiguousLength || 0) + '/' + (blobs?.core.length || 0)))

  const byteLength = [crayon.yellow(byteSize(core.byteLength))]
  if (isDrive) byteLength.push(crayon.yellow(byteSize(blobs?.core.byteLength || 0)))

  const peers = [crayon.yellow(core.peers.length)]
  if (isDrive) peers.push(crayon.yellow(blobs?.core.peers.length || 0))

  return format(
    '-',
    crayon.green(core.id),
    progress.join(' + ') + ' blks,',
    byteLength.join(' + ') + ',',
    peers.join(' + ') + ' peers,',
    crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.down())),
    crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.up())) + ' blks/s',
    crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.down())),
    crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.up()))
  )
}

function format (...args) {
  return args.join(' ') + '\n'
}

function onsocket (socket) {
  store.replicate(socket)
}
