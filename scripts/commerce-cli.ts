import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';

export async function readParameter(client: Pick<SSMClient, 'send'>, name: string): Promise<string> {
  try {
    const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!response.Parameter?.Value) throw new Error('parameter is empty');
    return response.Parameter.Value;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Could not read ${name}: ${message}`);
  }
}

export function operatorInput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid input.');
  }
}

export function failCli(command: string, message: string): never {
  console.error(`${command}: ${message}`);
  process.exit(1);
}
