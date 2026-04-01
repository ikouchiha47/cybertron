const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to bundle .tflite model files as assets
config.resolver.assetExts.push('tflite');

module.exports = config;
