import {
  configurationYaml,
  loadConfigurationMetadata,
} from './configuration-loader';

export async function loadConfigurationPageYaml(): Promise<string> {
  return configurationYaml(await loadConfigurationMetadata());
}
