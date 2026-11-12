/**
 * 自动更新链路验证（真实 Ed25519 验签）。
 *
 * ## minisign 字节布局与签名模式（踩了一小时才对，记清楚）
 *
 * 公钥 blob（42 字节）：
 *   [0..2)   "Ed"         算法标识
 *   [2..10)  keyId
 *   [10..42) 32 字节 Ed25519 公钥
 *
 * 签名 blob（74 字节）：
 *   [0..2)   "ED" 或 "Ed"  算法标识 ← **决定验签方式**
 *   [2..10)  keyId
 *   [10..74) 64 字节签名
 *
 * **关键**：`ED`（大写）表示预哈希模式 ——
 * 先对内容算 BLAKE2b-512，再对哈希做 Ed25519。Tauri 用的是这个。
 * `Ed` 才是直接对内容签名。用错模式会一直验不过，
 * 且看起来像"签名与文件不匹配"，非常容易误判成密钥问题。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
/** 更新服务器地址；默认用本地模拟服务器。 */
const SERVER = process.env.OCX_UPDATE_SERVER ?? 'http://127.0.0.1:47800';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function decodePublicKey(armored) {
  const raw = Buffer.from(armored, 'base64').toString('utf8');
  const keyB64 = raw.split('\n').find((l) => l.trim() && !l.startsWith('untrusted comment'));
  if (!keyB64) throw new Error('公钥里找不到密钥行');
  const blob = Buffer.from(keyB64, 'base64');
  return { keyId: blob.subarray(2, 10), keyBytes: blob.subarray(10, 42) };
}

function decodeSignature(armored) {
  const raw = Buffer.from(armored, 'base64').toString('utf8');
  const lines = raw.split('\n');
  const sigLine = lines.find(
    (l) => l.trim() && !l.startsWith('untrusted comment') && !l.startsWith('trusted comment'),
  );
  const trusted = lines.find((l) => l.startsWith('trusted comment:')) ?? '';

  const blob = Buffer.from(sigLine ?? '', 'base64');
  return {
    algorithm: blob.subarray(0, 2).toString('utf8'),
    keyId: blob.subarray(2, 10),
    signature: blob.subarray(10, 74),
    trustedComment: trusted.replace('trusted comment:', '').trim(),
  };
}

/** 按算法标识验签：ED = 预哈希（BLAKE2b-512），Ed = 直接签。 */
function verifyEd25519(publicKeyBytes, signature, content, algorithm = 'ED') {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const key = createPublicKey({
    key: Buffer.concat([prefix, publicKeyBytes]),
    format: 'der',
    type: 'spki',
  });
  const payload =
    algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  return cryptoVerify(null, payload, key, signature);
}

async function main() {
  console.log('自动更新链路验证（真实 Ed25519 验签）\n');

  console.log('[1] 更新服务器');
  const res = await fetch(`${SERVER}/latest.json`);
  check('latest.json 可达', res.status === 200, `HTTP ${res.status}`);
  const manifest = await res.json();
  const platform = manifest.platforms?.['windows-x86_64'];
  check('清单含 version', typeof manifest.version === 'string', manifest.version);
  check('清单含 signature', typeof platform?.signature === 'string');
  check('清单含 url', typeof platform?.url === 'string');

  console.log('\n[2] 安装包下载');
  const dl = await fetch(platform.url);
  check('安装包可达', dl.status === 200, `HTTP ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  check('内容非空', bytes.length > 1024 * 1024, `${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  console.log('\n[3] 验签（Ed25519）');
  const conf = JSON.parse(
    await readFile(path.join(ROOT, 'apps/shell/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const pubArmored = conf.plugins.updater.pubkey;
  const pub = decodePublicKey(pubArmored);
  const parsed = decodeSignature(platform.signature);

  check('**正版安装包通过验签**', verifyEd25519(pub.keyBytes, parsed.signature, bytes, parsed.algorithm));
  check(
    '签名 keyId 与公钥相符',
    Buffer.from(parsed.keyId).toString('hex') === Buffer.from(pub.keyId).toString('hex'),
    `${Buffer.from(parsed.keyId).toString('hex')} vs ${Buffer.from(pub.keyId).toString('hex')}`,
  );
  check('trusted comment 记录了版本', parsed.trustedComment.includes(`version:${manifest.version}`),
    parsed.trustedComment);

  console.log('\n[4] 篡改检测');
  const tamperedBytes = Buffer.from(bytes);
  tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0xff;
  check('篡改安装包后验签失败', !verifyEd25519(pub.keyBytes, parsed.signature, tamperedBytes, parsed.algorithm));

  const tamperedSig = Buffer.from(parsed.signature);
  tamperedSig[0] ^= 0xff;
  check('篡改签名后验签失败', !verifyEd25519(pub.keyBytes, tamperedSig, bytes, parsed.algorithm));

  const otherPub = Buffer.from(pub.keyBytes);
  otherPub[0] ^= 0xff;
  let rejected = false;
  try {
    rejected = !verifyEd25519(otherPub, parsed.signature, bytes, parsed.algorithm);
  } catch {
    rejected = true;
  }
  check('换一把公钥后验签失败', rejected);

  console.log('\n[5] 客户端配置');
  check('pubkey 已配置', typeof pubArmored === 'string' && pubArmored.length > 50);
  const endpoints = conf.plugins.updater.endpoints ?? [];
  check(
    'endpoints 指向 GitHub Releases（生产）',
    endpoints.some((e) => e.includes('github.com')),
    JSON.stringify(endpoints),
  );

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail === 0) {
    console.log('\n结论：更新包签名可被客户端内置公钥验证，篡改会被拒绝。');
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
