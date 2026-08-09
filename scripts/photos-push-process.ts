import { spawn, spawnSync } from 'node:child_process';

export interface CommandOptions {
  env?: Record<string, string>;
  allowFailure?: boolean;
}

export interface PushProcess {
  run(command: string, args: string[], options?: CommandOptions): void;
  runAsync(command: string, args: string[], options?: CommandOptions): Promise<void>;
  capture(command: string, args: string[], options?: CommandOptions): string;
}

export function createPushProcess(cwd: string): PushProcess {
  const environment = (extra?: Record<string, string>) => extra
    ? { ...process.env, ...extra }
    : process.env;

  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        cwd,
        stdio: 'inherit',
        env: environment(options.env),
      });
      if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
      if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`${command} exited with code ${result.status ?? 'unknown'}`);
      }
    },

    runAsync(command, args, options = {}) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          stdio: 'inherit',
          env: environment(options.env),
        });
        child.once('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
        child.once('close', (code) => {
          if (code === 0 || options.allowFailure) resolve();
          else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
        });
      });
    },

    capture(command, args, options = {}) {
      const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: environment(options.env) });
      if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
      if (result.status !== 0) {
        if (options.allowFailure) return '';
        throw new Error(result.stderr.trim() || `${command} failed`);
      }
      return result.stdout.trim();
    },
  };
}
