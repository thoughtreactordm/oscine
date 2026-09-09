const { join } = require('node:path')
module.exports = require(
  join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'cdrip.node')
)
