import { spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SecretSource, SecretsService } from '@opencoxswain/plugin-api';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const ENV_ALIASES: Record<string, string[]> = {
  llm_api_key: ['OPENCOXSWAIN_LLM_API_KEY', 'DEEPSEEK_API_KEY'],
};

const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$plain=[Console]::In.ReadToEnd()',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($plain)',
  '$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[IO.File]::WriteAllBytes($env:OPENCOXSWAIN_SECRET_PATH,$protected)',
].join('; ');

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$protected=[IO.File]::ReadAllBytes($env:OPENCOXSWAIN_SECRET_PATH)',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
].join('; ');

interface PowerShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPowerShell(
  script: string,
  stdin: string,
  env: Record<string, string>,
): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, env: { ...process.env, ...env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Windows DPAPI 密钥仓库：密文文件按当前用户加密，明文不落盘。
 * 读取优先仓库，未命中时回退环境变量（仅用于兼容既有部署）。
 */
export class DpapiVault implements SecretsService {
  readonly backend = process.platform === 'win32' ? 'dpapi' : 'unsupported';

  constructor(private readonly dir: string) {}

  async get(name: string): Promise<string | null> {
    const stored = await this.read(name);
    if (stored !== null && stored !== '') return stored;
    return this.fromEnv(name);
  }

  async source(name: string): Promise<SecretSource> {
    const stored = await this.read(name);
    if (stored !== null && stored !== '') return 'vault';
    return this.fromEnv(name) !== null ? 'env' : 'none';
  }

  async set(name: string, value: string): Promise<void> {
    this.assertName(name);
    if (value === '') throw new Error('密钥不能为空');
    if (this.backend !== 'dpapi') throw new Error('当前平台不支持 DPAPI 密钥托管');
    await mkdir(this.dir, { recursive: true });
    const result = await runPowerShell(PROTECT_SCRIPT, value, {
      OPENCOXSWAIN_SECRET_PATH: this.filePath(name),
    });
    if (result.code !== 0) {
      throw new Error(`写入密钥失败：${result.stderr.trim() || `exit ${result.code}`}`);
    }
  }

  async remove(name: string): Promise<void> {
    this.assertName(name);
    await rm(this.filePath(name), { force: true });
  }

  private async read(name: string): Promise<string | null> {
    this.assertName(name);
    if (this.backend !== 'dpapi') return null;
    const file = this.filePath(name);
    try {
      await access(file);
    } catch {
      return null;
    }
    const result = await runPowerShell(UNPROTECT_SCRIPT, '', {
      OPENCOXSWAIN_SECRET_PATH: file,
    });
    if (result.code !== 0) {
      throw new Error(`读取密钥失败：${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
  }

  private fromEnv(name: string): string | null {
    const keys = ENV_ALIASES[name] ?? [name.toUpperCase()];
    for (const key of keys) {
      const value = process.env[key]?.trim();
      if (value) return value;
    }
    return null;
  }

  private filePath(name: string): string {
    return path.join(this.dir, `${name}.bin`);
  }

  private assertName(name: string): void {
    if (!NAME_PATTERN.test(name)) throw new Error(`非法密钥名：${name}`);
  }
}
