// An explicit service capability. A web application does not imply a service.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { deliverChecks, TS_PACK } from "../ts/pack.ts";
import { runServiceCheck } from "./service-check.ts";

export const TS_SERVICE_PACK = "ts-service";
export const tsServicePack = definePack({
  name: TS_SERVICE_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [contribute(deliverChecks, [{
    name: "service-obligation",
    description: "ts-service requires an implemented ServiceRouter; with ts-web, its reachable network door must use that router's type",
    run: runServiceCheck,
  }])],
});
