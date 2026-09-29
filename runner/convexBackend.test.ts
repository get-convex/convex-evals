import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  utimesSync,
  statSync,
} from "fs";
import { join } from "path";
import { arch, platform, tmpdir } from "os";
import { rmSync } from "fs";
import JSZip from "jszip";
import {
  ADMIN_KEY,
  CACHED_BINARY_MAX_AGE_MS,
  downloadConvexBinaryImpl,
  fetchConvexReleasesWithRetry,
  findCachedConvexBinary,
  type GitHubRelease,
} from "./convexBackend.js";

describe("ADMIN_KEY", () => {
  it("is a non-empty hex string", () => {
    expect(ADMIN_KEY).toBeTruthy();
    expect(ADMIN_KEY).toMatch(/^[0-9a-f]+$/);
  });
});

describe("release fetch retries", () => {
  it.each([undefined, "test-token"])(
    "uses optional GitHub API authentication (%s)",
    async (token) => {
      const fetchImpl = (async (url, init) => {
        expect(url).toBe(
          "https://api.github.com/repos/get-convex/convex-backend/releases?per_page=50",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe(
          token ? `Bearer ${token}` : null,
        );
        return Response.json([]);
      }) as typeof fetch;
      await fetchConvexReleasesWithRetry(
        fetchImpl,
        async () => {},
        token ?? "",
      );
    },
  );

  it("keeps rate-limit evidence in exhausted 403 errors", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "123456",
        },
      })) as unknown as typeof fetch;
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      fetchConvexReleasesWithRetry(fetchImpl, async () => {}, ""),
    ).rejects.toThrow("rate limit remaining=0, reset=123456");
  });

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

describe("binary cache lookup", () => {
  let binaryDir: string;
  const isWindows = platform() === "win32";
  const exe = isWindows ? ".exe" : "";
  const cpuArch =
    ({ x64: "x86_64", arm64: "aarch64", ia32: "x86_64" } as const)[
      arch() as "x64" | "arm64" | "ia32"
    ] ?? arch();
  const osTriple =
    (
      {
        darwin: "apple-darwin",
        linux: "unknown-linux-gnu",
        win32: "pc-windows-msvc",
      } as const
    )[platform() as "darwin" | "linux" | "win32"] ?? platform();
  const assetName = `convex-local-backend-${cpuArch}-${osTriple}.zip`;

  const NOW = Date.UTC(2026, 8, 29);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = (): number => NOW;

  function writeBinary(name: string, ageMs: number = 0): string {
    const path = join(binaryDir, name);
    writeFileSync(path, "binary");
    chmodSync(path, 0o755);
    const mtimeSeconds = (NOW - ageMs) / 1000;
    utimesSync(path, mtimeSeconds, mtimeSeconds);
    return path;
  }

  function releasesFor(version: string): GitHubRelease[] {
    return [
      {
        tag_name: version,
        assets: [
          {
            name: assetName,
            browser_download_url: `https://example.test/${version}/${assetName}`,
          },
        ],
      },
    ];
  }

  async function zipResponse(): Promise<Response> {
    const zip = new JSZip();
    zip.file(`convex-local-backend${exe}`, "downloaded-binary");
    return new Response(await zip.generateAsync({ type: "uint8array" }));
  }

  beforeEach(() => {
    binaryDir = mkdtempSync(join(tmpdir(), "convex-binary-cache-"));
  });

  afterEach(() => {
    rmSync(binaryDir, { recursive: true, force: true });
  });

  it("uses the newest cached binary without calling the releases API", async () => {
    writeBinary(
      `convex-local-backend-precompiled-2026-08-12-c809010${exe}`,
      2 * DAY_MS,
    );
    const newest = writeBinary(
      `convex-local-backend-precompiled-2026-08-17-6363ab3${exe}`,
      DAY_MS,
    );
    let releaseCalls = 0;
    let downloadCalls = 0;

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => {
        releaseCalls++;
        return [];
      },
      fetchImpl: (async () => {
        downloadCalls++;
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch,
    });

    expect(result).toBe(newest);
    expect(releaseCalls).toBe(0);
    expect(downloadCalls).toBe(0);
  });

  it("uses a cached binary just inside the maximum age", async () => {
    const cached = writeBinary(
      `convex-local-backend-precompiled-2026-09-23-1111111${exe}`,
      CACHED_BINARY_MAX_AGE_MS - 1,
    );

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => {
        throw new Error("should not look up releases");
      },
    });

    expect(result).toBe(cached);
  });

  it("looks up and downloads the latest release when the cache is stale", async () => {
    writeBinary(
      `convex-local-backend-precompiled-2026-09-01-2222222${exe}`,
      CACHED_BINARY_MAX_AGE_MS + DAY_MS,
    );
    const version = "precompiled-2026-09-28-3333333";
    let releaseCalls = 0;
    const downloads: string[] = [];

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => {
        releaseCalls++;
        return releasesFor(version);
      },
      fetchImpl: (async (url: string) => {
        downloads.push(url);
        return zipResponse();
      }) as unknown as typeof fetch,
    });

    expect(releaseCalls).toBe(1);
    expect(downloads).toEqual([`https://example.test/${version}/${assetName}`]);
    expect(result).toBe(
      join(binaryDir, `convex-local-backend-${version}${exe}`),
    );
  });

  it("restarts the cache window when a stale binary is still the latest", async () => {
    const version = "precompiled-2026-09-01-4444444";
    const cached = writeBinary(
      `convex-local-backend-${version}${exe}`,
      CACHED_BINARY_MAX_AGE_MS,
    );

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => releasesFor(version),
      fetchImpl: (async () => {
        throw new Error("should not download");
      }) as unknown as typeof fetch,
    });

    expect(result).toBe(cached);
    expect(statSync(cached).mtimeMs).toBe(NOW);
  });

  it("falls back to a stale binary when the release lookup fails", async () => {
    const cached = writeBinary(
      `convex-local-backend-precompiled-2026-09-01-5555555${exe}`,
      CACHED_BINARY_MAX_AGE_MS + DAY_MS,
    );

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => {
        throw new Error("HTTP 403 (rate limit remaining=0)");
      },
    });

    expect(result).toBe(cached);
  });

  it("still fails when the release lookup fails and nothing is cached", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      downloadConvexBinaryImpl({
        binaryDir,
        now,
        refresh: false,
        fetchReleases: async () => {
          throw new Error("HTTP 403 (rate limit remaining=0)");
        },
      }),
    ).rejects.toThrow("rate limit remaining=0");
  });

  it("ignores release zips, partial downloads and empty files", () => {
    writeBinary(assetName);
    writeBinary(
      `convex-local-backend-precompiled-2026-09-01-aaaaaaa${exe}.partial`,
    );
    writeFileSync(
      join(
        binaryDir,
        `convex-local-backend-precompiled-2026-09-02-bbbbbbb${exe}`,
      ),
      "",
    );
    writeBinary("unrelated-file");

    expect(findCachedConvexBinary(binaryDir, isWindows)).toBeNull();
  });

  it.skipIf(isWindows)("ignores binaries without the executable bit", () => {
    const path = writeBinary(
      "convex-local-backend-precompiled-2026-09-03-ccccccc",
    );
    chmodSync(path, 0o644);

    expect(findCachedConvexBinary(binaryDir, false)).toBeNull();
  });

  it("returns null when the cache directory does not exist", () => {
    expect(
      findCachedConvexBinary(join(binaryDir, "missing"), isWindows),
    ).toBeNull();
  });

  it("downloads the latest release when nothing usable is cached", async () => {
    writeBinary(assetName);
    const version = "precompiled-2026-09-20-ddddddd";
    const downloads: string[] = [];

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: false,
      fetchReleases: async () => releasesFor(version),
      fetchImpl: (async (url: string) => {
        downloads.push(url);
        return zipResponse();
      }) as unknown as typeof fetch,
    });

    expect(result).toBe(
      join(binaryDir, `convex-local-backend-${version}${exe}`),
    );
    expect(downloads).toEqual([`https://example.test/${version}/${assetName}`]);
    expect(readFileSync(result, "utf-8")).toBe("downloaded-binary");
    expect(existsSync(`${result}.partial`)).toBe(false);
    expect(findCachedConvexBinary(binaryDir, isWindows)).toBe(result);
  });

  it("asks GitHub for the latest release when a refresh is requested", async () => {
    writeBinary(`convex-local-backend-precompiled-2026-08-12-c809010${exe}`);
    const version = "precompiled-2026-09-21-eeeeeee";
    let releaseCalls = 0;

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: true,
      fetchReleases: async () => {
        releaseCalls++;
        return releasesFor(version);
      },
      fetchImpl: (async () => zipResponse()) as unknown as typeof fetch,
    });

    expect(releaseCalls).toBe(1);
    expect(result).toBe(
      join(binaryDir, `convex-local-backend-${version}${exe}`),
    );
  });

  it("reuses a refreshed release that is already cached without downloading", async () => {
    const version = "precompiled-2026-09-22-fffffff";
    const cached = writeBinary(`convex-local-backend-${version}${exe}`);

    const result = await downloadConvexBinaryImpl({
      binaryDir,
      now,
      refresh: true,
      fetchReleases: async () => releasesFor(version),
      fetchImpl: (async () => {
        throw new Error("should not download");
      }) as unknown as typeof fetch,
    });

    expect(result).toBe(cached);
  });
});
