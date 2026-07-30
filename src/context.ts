/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Internal wiring shared across the high-level client, run handles, and data helpers. */

import { createClient, type Client, type Transport } from '@connectrpc/connect'

import type { ResolvedConfig } from './config'
import { createTransports } from './transport'
import { AuthMetadataService } from './gen/flyteidl2/auth/auth_service_pb'
import { ClusterService } from './gen/flyteidl2/cluster/service_pb'
import { DataProxyService } from './gen/flyteidl2/dataproxy/dataproxy_service_pb'
import { TaskService } from './gen/flyteidl2/task/task_service_pb'
import { RunService } from './gen/flyteidl2/workflow/run_service_pb'
import { TranslatorService } from './gen/flyteidl2/workflow/translator_service_pb'

export interface Services {
  run: Client<typeof RunService>
  task: Client<typeof TaskService>
  dataproxy: Client<typeof DataProxyService>
  translator: Client<typeof TranslatorService>
  cluster: Client<typeof ClusterService>
  auth: Client<typeof AuthMetadataService>
}

export interface ClientContext {
  config: ResolvedConfig
  services: Services
  /** Builds a DataProxy client bound to a resolved dataplane cluster base URL. */
  dataproxyForCluster: (baseUrl: string) => Client<typeof DataProxyService>
}

export function createContext(config: ResolvedConfig): ClientContext {
  const { transport, clusterTransport } = createTransports(config)

  const services: Services = {
    run: createClient(RunService, transport),
    task: createClient(TaskService, transport),
    dataproxy: createClient(DataProxyService, transport),
    translator: createClient(TranslatorService, transport),
    cluster: createClient(ClusterService, transport),
    auth: createClient(AuthMetadataService, transport),
  }

  const dataproxyForCluster = (baseUrl: string): Client<typeof DataProxyService> =>
    createClient(DataProxyService, clusterTransport(baseUrl) as Transport)

  return { config, services, dataproxyForCluster }
}
