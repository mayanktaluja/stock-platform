import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// Path-traversal guard for tarball members. `prefix` scopes extraction to one
// top-level directory inside the archive; it defaults to the SWS deep briefs so
// every pre-existing caller keeps its exact behaviour.
function safeTarMember(member, prefix = "deep/") {
  return (
    typeof member === "string" &&
    member.startsWith(prefix) &&
    member.endsWith(".json") &&
    !member.includes("..") &&
    !path.isAbsolute(member)
  );
}

function readTarString(buf, start, len) {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
}

function extractMemberWithNode(tarballPath, member, outPath) {
  const tar = zlib.gunzipSync(fs.readFileSync(tarballPath));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = readTarString(tar, offset, 100);
    if (!name) break;
    const prefix = readTarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeRaw = readTarString(tar, offset + 124, 12).replace(/\0/g, "").trim();
    const size = parseInt(sizeRaw || "0", 8) || 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (fullName === member) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, tar.subarray(dataStart, dataEnd));
      return true;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return false;
}

export function extractTarballWithNode({ tarballPath, extractBase, memberPrefix = "deep/" }) {
  if (!fs.existsSync(tarballPath)) return false;
  const tar = zlib.gunzipSync(fs.readFileSync(tarballPath));
  let extracted = 0;
  fs.mkdirSync(extractBase, { recursive: true });

  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = readTarString(tar, offset, 100);
    if (!name) break;
    const prefix = readTarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeRaw = readTarString(tar, offset + 124, 12).replace(/\0/g, "").trim();
    const size = parseInt(sizeRaw || "0", 8) || 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (safeTarMember(fullName, memberPrefix)) {
      const outPath = path.join(extractBase, fullName);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, tar.subarray(dataStart, dataEnd));
      extracted++;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return extracted > 0;
}

export function extractMemberFromTarball({
  tarballPath,
  extractBase,
  member,
  tarCommand = "tar",
}) {
  if (!safeTarMember(member) || !fs.existsSync(tarballPath)) return null;
  const outPath = path.join(extractBase, member);
  fs.mkdirSync(extractBase, { recursive: true });
  try {
    execFileSync(tarCommand, ["-xzf", tarballPath, "-C", extractBase, member], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    try {
      if (!extractMemberWithNode(tarballPath, member, outPath)) return null;
    } catch {
      return null;
    }
  }
  return fs.existsSync(outPath) ? outPath : null;
}

export function makeDeepFileResolver({
  deepDir,
  tarballPath,
  extractBase,
  tarCommand = "tar",
}) {
  const extracted = new Map();

  return function resolveDeepFile(key) {
    if (!key) return null;
    const loosePath = path.join(deepDir, `${key}.json`);
    const looseStat = statOrNull(loosePath);
    const tarStat = statOrNull(tarballPath);

    if (tarStat && (!looseStat || tarStat.mtimeMs > looseStat.mtimeMs)) {
      const member = `deep/${key}.json`;
      const outPath = path.join(extractBase, member);
      const outStat = statOrNull(outPath);
      const cached = extracted.get(key);
      if (
        cached &&
        cached.tarMtimeMs === tarStat.mtimeMs &&
        outStat &&
        outStat.mtimeMs >= tarStat.mtimeMs
      ) {
        return outPath;
      }
      const extractedPath = extractMemberFromTarball({
        tarballPath,
        extractBase,
        member,
        tarCommand,
      });
      if (extractedPath) {
        try {
          const t = new Date(tarStat.mtimeMs);
          fs.utimesSync(extractedPath, t, t);
        } catch {}
        extracted.set(key, { tarMtimeMs: tarStat.mtimeMs });
        return extractedPath;
      }
    }

    return looseStat ? loosePath : null;
  };
}
