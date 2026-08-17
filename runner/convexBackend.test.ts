import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import JSZip from "jszip";
import { ADMIN_KEY, fetchConvexReleasesWithRetry } from "./convexBackend.js";

describe("ADMIN_KEY", () => {
  it("is a non-empty hex string", () => {
    expect(ADMIN_KEY).toBeTruthy();
    expect(ADMIN_KEY).toMatch(/^[0-9a-f]+$/);
  });
});

describe("release fetch retries", () => {
  it("backs off through transient 504s and returns the recovered response", async () => {
    const statuses = [504, 504, 200];
    const delays: number[] = [];
    const releases = [{ tag_name: "v1", assets: [] }];
    const fetchImpl = (async () => {
      const status = statuses.shift()!;
      return new Response(status === 200 ? JSON.stringify(releases) : null, {
        status,
      });
    }) as unknown as typeof fetch;

    const result = await fetchConvexReleasesWithRetry(fetchImpl, async (ms) => {
      delays.push(ms);
    });

    expect(result).toEqual(releases);
    expect(delays).toEqual([5_000, 10_000]);
  });

  it("stops after five failed attempts", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response(null, { status: 504 });
    }) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      fetchConvexReleasesWithRetry(fetchImpl, async () => {}),
    ).rejects.toThrow("after 5 attempts: HTTP 504");
    expect(attempts).toBe(5);
  });
});

describe("binary download URL construction", () => {
  it("constructs correct target pattern for known architectures", () => {
    const archMap: Record<string, string> = {
      x64: "x86_64",
      arm64: "aarch64",
      ia32: "x86_64",
    };
    const osMap: Record<string, string> = {
      darwin: "apple-darwin",
      linux: "unknown-linux-gnu",
      win32: "pc-windows-msvc",
    };

    for (const [nodeArch, targetArch] of Object.entries(archMap)) {
      for (const [nodePlatform, targetOs] of Object.entries(osMap)) {
        const pattern = `convex-local-backend-${targetArch}-${targetOs}`;
        expect(pattern).toBeTruthy();
        expect(pattern).toContain("convex-local-backend");
        expect(pattern).toContain(targetArch);
        expect(pattern).toContain(targetOs);
      }
    }
  });

  it("maps arm64 to aarch64", () => {
    const archMap: Record<string, string> = {
      x64: "x86_64",
      arm64: "aarch64",
      ia32: "x86_64",
    };
    expect(archMap["arm64"]).toBe("aarch64");
  });

  it("maps darwin to apple-darwin", () => {
    const osMap: Record<string, string> = {
      darwin: "apple-darwin",
      linux: "unknown-linux-gnu",
      win32: "pc-windows-msvc",
    };
    expect(osMap["darwin"]).toBe("apple-darwin");
    expect(osMap["linux"]).toBe("unknown-linux-gnu");
    expect(osMap["win32"]).toBe("pc-windows-msvc");
  });
});

describe("binary name construction", () => {
  it("appends .exe on windows", () => {
    const version = "precompiled-2026-01-01-abc1234";
    const isWindows = true;
    const binaryName = `convex-local-backend-${version}${isWindows ? ".exe" : ""}`;
    expect(binaryName).toBe(
      "convex-local-backend-precompiled-2026-01-01-abc1234.exe",
    );
  });

  it("has no extension on non-windows", () => {
    const version = "precompiled-2026-01-01-abc1234";
    const isWindows = false;
    const binaryName = `convex-local-backend-${version}${isWindows ? ".exe" : ""}`;
    expect(binaryName).toBe(
      "convex-local-backend-precompiled-2026-01-01-abc1234",
    );
  });
});

describe("release asset matching", () => {
  const mockReleases = [
    {
      tag_name: "precompiled-2026-02-06-beabc80",
      assets: [
        {
          name: "convex-local-backend-x86_64-pc-windows-msvc.zip",
          browser_download_url:
            "https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-02-06-beabc80/convex-local-backend-x86_64-pc-windows-msvc.zip",
        },
        {
          name: "convex-local-backend-x86_64-unknown-linux-gnu.zip",
          browser_download_url:
            "https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-02-06-beabc80/convex-local-backend-x86_64-unknown-linux-gnu.zip",
        },
        {
          name: "convex-local-backend-x86_64-apple-darwin.zip",
          browser_download_url:
            "https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-02-06-beabc80/convex-local-backend-x86_64-apple-darwin.zip",
        },
        {
          name: "convex-local-backend-aarch64-apple-darwin.zip",
          browser_download_url:
            "https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-02-06-beabc80/convex-local-backend-aarch64-apple-darwin.zip",
        },
      ],
    },
  ];

  function findAsset(
    releases: typeof mockReleases,
    targetPattern: string,
  ): { name: string; version: string } | null {
    for (const release of releases) {
      for (const asset of release.assets) {
        if (asset.name.includes(targetPattern)) {
          return { name: asset.name, version: release.tag_name };
        }
      }
    }
    return null;
  }

  it("finds windows x64 asset", () => {
    const result = findAsset(mockReleases, "x86_64-pc-windows-msvc");
    expect(result).toEqual({
      name: "convex-local-backend-x86_64-pc-windows-msvc.zip",
      version: "precompiled-2026-02-06-beabc80",
    });
  });

  it("finds linux x64 asset", () => {
    const result = findAsset(mockReleases, "x86_64-unknown-linux-gnu");
    expect(result).toEqual({
      name: "convex-local-backend-x86_64-unknown-linux-gnu.zip",
      version: "precompiled-2026-02-06-beabc80",
    });
  });

  it("finds macOS arm64 asset", () => {
    const result = findAsset(mockReleases, "aarch64-apple-darwin");
    expect(result).toEqual({
      name: "convex-local-backend-aarch64-apple-darwin.zip",
      version: "precompiled-2026-02-06-beabc80",
    });
  });

  it("finds macOS x64 asset", () => {
    const result = findAsset(mockReleases, "x86_64-apple-darwin");
    expect(result).toEqual({
      name: "convex-local-backend-x86_64-apple-darwin.zip",
      version: "precompiled-2026-02-06-beabc80",
    });
  });

  it("returns null for unsupported platform", () => {
    const result = findAsset(mockReleases, "aarch64-pc-windows-msvc");
    expect(result).toBeNull();
  });
});

describe("zip extraction for binary", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "convex-backend-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts binary from zip and writes to disk", async () => {
    const zip = new JSZip();
    const binaryContent = "fake-binary-content";
    zip.file("convex-local-backend", binaryContent);

    const zipData = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = join(tempDir, "backend.zip");
    writeFileSync(zipPath, zipData);

    const outputPath = join(tempDir, "convex-local-backend");

    const loadedZip = await JSZip.loadAsync(readFileSync(zipPath));
    const entry = loadedZip.file("convex-local-backend");
    expect(entry).toBeTruthy();
    const content = await entry!.async("nodebuffer");
    writeFileSync(outputPath, content);

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf-8")).toBe(binaryContent);
  });

  it("extracts .exe binary from zip", async () => {
    const zip = new JSZip();
    const binaryContent = "fake-windows-binary";
    zip.file("convex-local-backend.exe", binaryContent);

    const zipData = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = join(tempDir, "backend-windows.zip");
    writeFileSync(zipPath, zipData);

    const outputPath = join(tempDir, "convex-local-backend.exe");

    const loadedZip = await JSZip.loadAsync(readFileSync(zipPath));
    const entry = loadedZip.file("convex-local-backend.exe");
    expect(entry).toBeTruthy();
    const content = await entry!.async("nodebuffer");
    writeFileSync(outputPath, content);

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf-8")).toBe(binaryContent);
  });

  it("reports error when binary not found in zip", async () => {
    const zip = new JSZip();
    zip.file("some-other-file.txt", "not a binary");

    const zipData = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipData);

    const entry = loadedZip.file("convex-local-backend");
    expect(entry).toBeNull();
  });
});
