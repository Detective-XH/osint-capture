const sharp = require('sharp');
const sizes = [16, 32, 48, 128];
Promise.all(sizes.map(s =>
  sharp(`src/icons/icon${s}.svg`)
    .resize(s, s)
    .png()
    .toFile(`src/icons/icon${s}.png`)
)).then(() => console.log('Icons converted.'));
