// Signs the update files in dist/ (macOS .zip, Linux .AppImage) for the
// in-app updater: writes <file>.sig next to each. The Ed25519 private key
// comes from the UPDATE_SIGNING_KEY environment variable (a CI secret).
//
//   UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-update.js [dist]

const fs = require('fs');
const path = require('path');
const { sha512File, sign, verify } = require('../src/main/update-signature');

async function main() {
  const dir = process.argv[2] || 'dist';
  const key = process.env.UPDATE_SIGNING_KEY;
  if (!key) {
    console.error('UPDATE_SIGNING_KEY is not set');
    process.exit(1);
  }
  // The version the build wrote into its feed, which describes these files.
  const feed = fs.readdirSync(dir).find((f) => /^latest.*\.yml$/.test(f));
  const version = feed
    ? fs.readFileSync(path.join(dir, feed), 'utf8').match(/^version:\s*['"]?([^'"\s]+)/m)[1]
    : require('../package.json').version;
  const files = fs.readdirSync(dir).filter((f) => /\.(zip|AppImage)$/.test(f));
  if (!files.length) {
    console.error(`No .zip or .AppImage in ${dir}`);
    process.exit(1);
  }
  for (const name of files) {
    const fields = { version, name, sha512: await sha512File(path.join(dir, name)) };
    const signature = sign(fields, key);
    // Catches a private key that doesn't match the app's public key.
    if (!verify(fields, signature)) {
      console.error('The signing key does not match the public key in src/main/update-signature.js');
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, `${name}.sig`), signature + '\n');
    console.log(`signed ${name}`);
  }
}

main();
