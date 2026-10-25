import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MANAGED_ENV_KEYS = ['MONGODB_URI', 'OPENROUTER_API_KEY', 'LEADAI_SETUP_COMPLETE'];

function updateEnvContent(content, values) {
  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set();
  const result = [];

  for (const line of lines) {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = assignment?.[1];
    if (!key || !Object.hasOwn(values, key)) {
      result.push(line);
      continue;
    }
    if (updatedKeys.has(key)) continue;
    result.push(`${key}=${JSON.stringify(String(values[key]))}`);
    updatedKeys.add(key);
  }

  for (const key of MANAGED_ENV_KEYS) {
    if (Object.hasOwn(values, key) && !updatedKeys.has(key)) {
      result.push(`${key}=${JSON.stringify(String(values[key]))}`);
    }
  }

  return result.join('\n').replace(/\n*$/, '\n');
}

async function readCurrentEnv(envPath, templatePath) {
  try {
    return { content: await fs.readFile(envPath, 'utf8'), existed: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    return { content: await fs.readFile(templatePath, 'utf8'), existed: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { content: '', existed: false };
  }
}

async function replaceEnvFile(envPath, content) {
  const temporaryPath = `${envPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, envPath);
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not write the environment file or clean up its temporary file.');
    }
    throw error;
  }
}

export async function persistEnvSettings(values, envPath, templatePath) {
  if (Object.keys(values).some((key) => !MANAGED_ENV_KEYS.includes(key))) {
    throw new Error('Unsupported backend environment setting.');
  }
  const previous = await readCurrentEnv(envPath, templatePath);
  await replaceEnvFile(envPath, updateEnvContent(previous.content, values));
  return previous;
}

export async function restoreEnvFile(snapshot, envPath) {
  if (snapshot.existed) {
    await replaceEnvFile(envPath, snapshot.content);
    return;
  }
  await fs.rm(envPath, { force: true });
}
