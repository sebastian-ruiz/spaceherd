// Update signatures, as Sparkle does it: releases are signed with our own
// Ed25519 key (the private half is a CI secret), and the app checks them with
// the public half below. No Apple Developer ID is involved.
//
// The signature covers the version and file name with the file's SHA-512, so
// an older signed file can't be passed off as a newer version.

const crypto = require('crypto');
const fs = require('fs');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4smKm5RQU4qDkgG/6RfXRclrZAx3ssxfqxnPWzGupq0=
-----END PUBLIC KEY-----
`;

// Base64 SHA-512 of a file, the form latest-*.yml uses.
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

function signedMessage({ version, name, sha512 }) {
  return Buffer.from(`spaceherd-update:1:${version}:${name}:${sha512}`);
}

// Base64 signature, for the .sig file next to a release file.
function sign(fields, privateKeyPem) {
  return crypto.sign(null, signedMessage(fields), privateKeyPem).toString('base64');
}

function verify(fields, signatureBase64, publicKeyPem = PUBLIC_KEY) {
  try {
    return crypto.verify(null, signedMessage(fields), publicKeyPem, Buffer.from(signatureBase64.trim(), 'base64'));
  } catch {
    return false;
  }
}

module.exports = { sha512File, sign, verify, PUBLIC_KEY };
