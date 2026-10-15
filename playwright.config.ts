import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./test/e2e",
    testMatch: "**/*.spec.ts",
    timeout: 30_000,
    use: { baseURL: "http://localhost:4183" },
    webServer: {
        command: "node test/e2e/server.mjs",
        url: "http://localhost:4183/index.html",
        reuseExistingServer: true,
        timeout: 20_000,
    },
});
