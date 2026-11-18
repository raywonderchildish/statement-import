// Config plugin: allow plain HTTP on Android only to the local mock (loopback and
// the emulator's host alias). Everything else stays HTTPS-only. This is a native
// change: editing the list requires a new binary, not an OTA update.
//
// Debug builds get a permissive override in the debug source set: the dev server
// (Metro) is reached over plain HTTP at whatever LAN address the tooling picks,
// and a strict policy would stop a development build from loading at all.
// Release builds never see that file and keep the strict policy below.
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '10.0.2.2'];

const xml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
${LOCAL_HOSTS.map(host => `        <domain includeSubdomains="false">${host}</domain>`).join('\n')}
    </domain-config>
</network-security-config>
`;

const debugXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

module.exports = function withLocalCleartext(config) {
  config = withDangerousMod(config, [
    'android',
    async modConfig => {
      const directory = path.join(modConfig.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'network_security_config.xml'), xml);
      const debugDirectory = path.join(modConfig.modRequest.platformProjectRoot, 'app/src/debug/res/xml');
      fs.mkdirSync(debugDirectory, { recursive: true });
      fs.writeFileSync(path.join(debugDirectory, 'network_security_config.xml'), debugXml);
      return modConfig;
    },
  ]);
  return withAndroidManifest(config, modConfig => {
    const application = modConfig.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return modConfig;
  });
};
