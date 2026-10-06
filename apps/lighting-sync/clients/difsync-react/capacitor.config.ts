import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.difsync.react",
  appName: "DifSync",
  webDir: "dist",
  server: {
    cleartext: true,
  },
};

export default config;
