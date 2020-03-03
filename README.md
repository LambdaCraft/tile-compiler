# Minecraft Tile Compiler
Create TMS tiles compatible with leaflet using [BlockMap](https://github.com/Minecraft-Technik-Wiki/BlockMap)

## Usage
```
  npm install --global
  tile-compiler --help
```

Or with docker:

```
  docker built -t blocktiles .
  docker run -it -v <mc world folder>:/world -v `pwd`/tiles:/tiles -it blocktiles -m overworld,the_nether,the_end -c PNGQUANT /world
```
