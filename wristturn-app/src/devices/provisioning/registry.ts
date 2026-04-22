import type { IBulbProvisioner } from "./IBulbProvisioner";
import { WizProvisioner } from "./WizProvisioner";
import { WiproProvisioner } from "./WiproProvisioner";

export const BULB_PROVISIONERS: IBulbProvisioner[] = [
  new WizProvisioner(),
  new WiproProvisioner(),
];
