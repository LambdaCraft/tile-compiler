const workerpool = require('workerpool')
const fs = require('fs-extra')
const pngquant = require('node-pngquant-native')
const sharp = require('sharp')

const compressFile = (path, outputPath) => {
  const buff = fs.readFileSync(path)
  const resBuff = pngquant.compress(buff, { speed: 10 })
  fs.writeFileSync(outputPath, resBuff)
}

// const minBy = require('lodash/minBy')
// const maxBy = require('lodash/maxBy')
// const sortBy = require('lodash/sortBy')
// const sharp = require('sharp')

function combineTiles(tile) {
  return new Promise(async (res, rej) => {
    try {
      const parts = tile.quadPoints
        .map((p, i) => [p, i])
        .filter(([p]) => fs.existsSync(p.path))
      if (!parts.length) return res()

      const meta = await sharp(parts[0][0].path).metadata()
      const halfw = meta.width / 2;
      const halfh = meta.height / 2;
      const toCompositeOp = (input, i) => ({
        input,
        top: Math.floor(i / 2) * meta.height,
        left: (i % 2) * meta.width,
      })

      const shrunken = await Promise.all(parts.map(async ([p, i]) => {
        const buf = await sharp(p.path)
          .resize(halfw, halfh)
          .toBuffer()

        return toCompositeOp(buf, i)
      }))

      const buff = await sharp({
          create: {
            width: meta.width,
            height: meta.height,
            channels: meta.channels,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          }
        })
        .composite(shrunken)
        .png()
        .toBuffer()
    
      const compressBuff = pngquant.compress(buff, { speed: 10 })
      fs.writeFileSync(tile.outPath, compressBuff)
    } catch (e) {
      console.error('ERRRRR', tile, e)
      rej(e)
    }
    res()
  })
}

workerpool.worker({
  compressFile,
  combineTiles,
});
