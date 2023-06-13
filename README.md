# simple-seeder

Dead simple Hypercore seeder

```
npm install -g simple-seeder
```

## Usage

Three ways to load seeds, you can only use one approach per process:

#### Args
You use those args:

```
--core, -c <key>
--bee, -b <key>
--drive, -d <key>
--seeders, -s <key>
```

```
simple-seeder -c <key> -c <another-key>
```

The `seeders` option is only for drives, and must use the same drive key to enable it.

#### File
A file containing the seeds list:

`seeds.txt`
```
core <key>
bee <key>
drive <key>
seeders <key>
```

```
simple-seeder --file ./seeds.txt
```

#### List
A Hyperbee list that can receive updates in real-time.

Manage the list with `simple-seeder --menu [key]`

The menu will also show you the Hyperbee list key that you can use:
```
simple-seeder <key>
```

## License

Apache-2.0
