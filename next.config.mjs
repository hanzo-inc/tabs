/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A STATIC EXPORT. Tabs has no backend by design: it reads the control plane
  // from the browser with the caller's own IAM token and frames terminals the
  // machines themselves serve. With nothing to run at request time, a server
  // would only be something else to keep up.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  // The end-to-end suite's host page (app/e2e/page.e2e.tsx) is a route only in
  // a build made for it, so the export that ships never carries it.
  pageExtensions: process.env.TABS_E2E === '1' ? ['e2e.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
  // The gui packages ship untranspiled ESM resolved against react-native.
  transpilePackages: ['@hanzo/gui', '@hanzo/ui', 'react-native-web'],
  // @hanzo/ui renders through @hanzo/gui, which is React Native's component
  // model. On web `react-native` IS `react-native-web`, and the packages that
  // reach for the former (@hanzogui/sheet, the icon set's svg backend) resolve
  // to real React Native without this — a Flow-typed source webpack cannot
  // parse. The `.web.*` extensions are the other half: a package that ships a
  // web variant beside its native one is asking to be chosen by extension.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      'react-native$': 'react-native-web',
      // react-native-svg reads the asset registry; the web one lives here.
      '@react-native/assets-registry/registry': 'react-native-web/dist/modules/AssetRegistry',
    };
    config.resolve.extensions = [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      ...config.resolve.extensions,
    ];
    return config;
  },
};
