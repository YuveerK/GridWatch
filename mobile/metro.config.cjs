const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const resolve = config.resolver.resolveRequest;

// Metro does not pick up the icon font inside @expo/vector-icons in this repo.
// Hand it the file when the package asks for it.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.ttf')) {
    const candidate = path.resolve(path.dirname(context.originModulePath), moduleName);
    if (fs.existsSync(candidate)) return { type: 'assetFiles', filePaths: [candidate] };
  }
  return resolve ? resolve(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
