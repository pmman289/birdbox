export interface ConfigResourceFile {
  relativePath: string;
  content: string;
}

export interface NodeConfigBundle {
  main: string;
  resources: ConfigResourceFile[];
  removedResources?: string[];
}

export function configBundle(value: string | NodeConfigBundle): NodeConfigBundle {
  return typeof value === "string" ? { main: value, resources: [], removedResources: [] } : { ...value, removedResources: value.removedResources ?? [] };
}
