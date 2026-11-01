/**
 * \author Toximik
 * \file identity.ts
 * \brief Connect handshake: reads the identity messages and checks that the
 *        board runs RC_Controller firmware with a compatible API.
 */

import type { MspClient } from "./client.ts";
import {
  decodeApiVersion,
  decodeBoardInfo,
  decodeBuildInfo,
  decodeFcVariant,
  decodeFcVersion,
  type ApiVersion,
  type BoardInfo,
  type BuildInfo,
} from "./payloads.ts";
import { API_MAJOR, FC_VARIANT, MSP } from "./protocol.ts";

export interface Identity {
  api: ApiVersion;
  variant: string;
  firmware: string;
  board: BoardInfo;
  build: BuildInfo;
  /** Board API minor is newer than this configurator knows (works, new features not shown) */
  newerMinor: boolean;
}

export class IncompatibleBoard extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleBoard";
  }
}

export async function readIdentity(client: MspClient, knownMinor: number): Promise<Identity> {
  // Variant first: another firmware may not know our IDs at all
  const variant = decodeFcVariant(await client.request(MSP.FC_VARIANT));
  if (variant !== FC_VARIANT) {
    throw new IncompatibleBoard(`not an RC_Controller board (firmware variant "${variant}", expected "${FC_VARIANT}")`);
  }
  const api = decodeApiVersion(await client.request(MSP.API_VERSION));
  if (api.major !== API_MAJOR) {
    throw new IncompatibleBoard(
      `firmware API ${api.major}.${api.minor} is not supported (configurator speaks API ${API_MAJOR}.x) – ` +
        (api.major > API_MAJOR ? "update the configurator" : "update the firmware"),
    );
  }
  const [fw, board, build] = client.requestMany([{ id: MSP.FC_VERSION }, { id: MSP.BOARD_INFO }, { id: MSP.BUILD_INFO }]);
  return {
    api,
    variant,
    firmware: decodeFcVersion(await fw!),
    board: decodeBoardInfo(await board!),
    build: decodeBuildInfo(await build!),
    newerMinor: api.minor > knownMinor,
  };
}
