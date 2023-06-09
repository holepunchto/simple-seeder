const Hyperbee = require('hyperbee')
const HypercoreId = require('hypercore-id-encoding')
const crayon = require('tiny-crayon')
const Menu = require('tiny-menu')

const types = ['core', 'bee', 'drive']

module.exports = async function (key, { store, swarm }) {
  const storeOptions = {}

  if (typeof key === 'string') {
    storeOptions.key = HypercoreId.decode(key)
  } else {
    storeOptions.name = 'list'
  }

  const core = store.get(storeOptions)
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()

  const done = bee.core.findingPeers()
  swarm.join(bee.core.discoveryKey)
  swarm.flush().then(done, done)

  const menu = new Menu({
    clear: false,
    render (page) {
      this.create(crayon.bgGray('Menu') + ' (list key): ' + crayon.green(HypercoreId.encode(core.key)))

      this.add(1, 'Listing')
      this.add(2, 'Add')
      this.add(3, 'Delete')
      this.add(4, 'Edit\n')

      this.add(9, 'Generate new list\n')

      this.add(0, 'Exit')
    },
    async handler (item, value, page) {
      if (item === 0 || item === null) return

      if (item === 1 || item === 3 || item === 4) {
        // TODO: add some kind of "userData" to menu to avoid this. Maybe it can be passed down like show({ userData })
        list.$action = item
        return list.show()
      }

      if (item === 2) {
        // TODO: menu should allow no items while still asking for inputs from the user
        console.log(crayon.bgGray('Add new resource'))
        console.log()

        const type = await this.ask('Type: ' + crayon.gray('[' + types.join('/') + ']') + ' ')

        if (types.indexOf(type) === -1) {
          if (type === null) {
            console.log()
            return menu.show()
          }
          console.log(crayon.red('Invalid type: ' + type))
          return
        }

        const key = await this.ask('Key: ')
        if (key === null) {
          console.log()
          return menu.show()
        }

        let id = null
        try {
          id = HypercoreId.encode(HypercoreId.decode(key))
        } catch {
          console.log(crayon.red('Invalid key format: ' + key))
          return
        }

        const current = await bee.get(id, { wait: false })
        if (current && current.value.type === type) {
          console.log(crayon.red('Key already exists'))
          return
        }

        const description = await this.ask('Description: ')
        if (description === null) {
          console.log()
          return menu.show()
        }

        let seeders = false

        if (type === 'drive') {
          const addSeeders = await this.ask('Enable swarm seeders? [Y/n] ')
          if (addSeeders === null) {
            console.log()
            return menu.show()
          }

          seeders = addSeeders.toLowerCase() === 'y'
        }

        await bee.put(id, { type, description, seeders })

        console.log(crayon.green('Item added'))
        console.log()

        return menu.show()
      }

      if (item === 9) {
        const core = store.get({ name: Math.random().toString() })
        await core.ready()

        console.log(crayon.bgGray('New list'))
        console.log()

        console.log('List key:', crayon.green(core.id))
        console.log('Use it like so: --menu <key>')
      }
    }
  })

  const list = new Menu({
    clear: false,
    async render (page) {
      if (list.$action === 1) this.create(crayon.bgGray('Items'))
      else if (list.$action === 3) this.create(crayon.bgGray('Delete item'))
      else if (list.$action === 4) this.create(crayon.bgGray('Edit item'))

      let count = 0

      for (const type of types) {
        for await (const entry of bee.createReadStream()) {
          if (type !== entry.value.type) continue

          count++
          const text = crayon.yellow(count + '.') + ' ' + crayon.magenta(entry.value.type.toUpperCase()) + ' ' + crayon.green(entry.key) + ' ' + crayon.gray(entry.value.description)
          const value = { entry }

          this.add(count, text, { value, custom: true, disabled: list.$action === 1 })
        }
      }

      if (count === 0) this.add(-1, crayon.gray('No items'))

      this.add(-1, '')
      this.add(0, 'Go back')

      return count
    },
    async ask (count) {
      // If no items or just List items then default ask behaviour
      if (count === 0 || list.$action === 1) return this.ask()
      // Otherwise ask which item to Delete or Edit
      return this.ask('Item: ' + crayon.gray('[number]') + ' ')
    },
    async handler (item, value, page) {
      if (item === 0 || item === null) {
        if (list.$action !== 1) console.log()
        return menu.show()
      }

      if (list.$action === 1) return list.show()

      // Delete
      if (list.$action === 3) {
        const { entry } = value

        await bee.del(entry.key)

        console.log(crayon.red('Item removed'))
        console.log()

        return list.show()
      }

      // Edit
      if (list.$action === 4) {
        const { entry } = value

        // TODO: maybe ask which property to edit?

        const description = await this.ask('New description: ')
        if (description === null) return

        const addSeeders = await this.ask('Enable swarm seeder? [Y/n] ')
        if (addSeeders === null) {
          console.log()
          return menu.show()
        }

        const seeders = addSeeders.toLowerCase() === 'y'

        await bee.put(entry.key, { ...entry.value, description, seeders })

        console.log(crayon.green('Item updated'))
        console.log()

        return list.show()
      }
    }
  })

  await menu.show()
}
