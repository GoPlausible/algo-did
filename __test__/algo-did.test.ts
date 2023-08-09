/* eslint-disable no-plusplus */
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import {
  describe, expect, beforeAll, it,
} from '@jest/globals';
import algosdk from 'algosdk';
import { algodClient, kmdClient } from './common';
import appSpec from '../contracts/artifacts/AlgoDID.json';

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 32768;

const BYTES_PER_CALL = 2048
- 4 // 4 bytes for the method selector
- 64 // 64 bytes for the name
- 8 // 8 bytes for the box index
- 8; // 8 bytes for the offset
type Metadata = {start: bigint, end: bigint, uploading: bigint, endSize: bigint};

// pubkey encoding for now use Algorand base32 address
// did = did:algo:<pubKey>-<providerAppId>
async function resolveDID(did: string): Promise<Buffer> {
  const splitDid = did.split(':');

  if (splitDid[0] !== 'did') throw new Error(`Invalid protocol. Expected 'did', got ${splitDid[0]}`);
  if (splitDid[1] !== 'algo') throw new Error(`Invalid DID method. Expected 'algod', got ${splitDid[1]}`);

  const splitID = splitDid[2].split('-');

  let pubKey: Uint8Array;
  try {
    pubKey = algosdk.decodeAddress(splitID[0]).publicKey;
  } catch (e) {
    throw new Error(`Invalid public key. Expected Algorand address, got ${splitID[0]}`);
  }

  let appID: bigint;

  try {
    appID = BigInt(splitID[1]);
    algosdk.encodeUint64(appID);
  } catch (e) {
    throw new Error(`Invalid app ID. Expected uint64, got ${splitID[1]}`);
  }

  const appClient = new ApplicationClient({
    resolveBy: 'id',
    id: appID,
    sender: algosdk.generateAccount(),
    app: JSON.stringify(appSpec),
  }, algodClient);

  const boxValue = (await appClient.getBoxValueFromABIType(pubKey, algosdk.ABIType.from('(uint64,uint64,uint8,uint64)'))).valueOf() as bigint[];

  const metadata: Metadata = {
    start: boxValue[0], end: boxValue[1], uploading: boxValue[2], endSize: boxValue[3],
  };

  if (metadata.uploading) throw new Error('DID document is still being uploaded');

  const boxPromises = [];
  for (let i = metadata.start; i <= metadata.end; i += 1n) {
    boxPromises.push(appClient.getBoxValue(algosdk.encodeUint64(i)));
  }

  const boxValues = await Promise.all(boxPromises);

  return Buffer.concat(boxValues);
}

async function uploadDIDDocument(
  data: Buffer,
  appID: number,
  pubKey: Uint8Array,
  sender: algosdk.Account,
): Promise<Metadata> {
  const appClient = new ApplicationClient({
    resolveBy: 'id',
    id: appID,
    sender,
    app: JSON.stringify(appSpec),
  }, algodClient);

  const ceilBoxes = Math.ceil(data.byteLength / MAX_BOX_SIZE);

  const endBoxSize = data.byteLength % MAX_BOX_SIZE;

  const totalCost = ceilBoxes * COST_PER_BOX
    + (ceilBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE
    + ceilBoxes * 64 * COST_PER_BYTE
    + endBoxSize * COST_PER_BYTE;

  const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    from: sender.addr,
    to: (await appClient.getAppReference()).appAddress,
    amount: totalCost,
    suggestedParams: await algodClient.getTransactionParams().do(),
  });

  await appClient.call({
    method: 'startUpload',
    methodArgs: [pubKey, ceilBoxes, endBoxSize, mbrPayment],
    boxes: [
      pubKey,
    ],
    sendParams: { suppressLog: true },
  });

  const boxValue = (await appClient.getBoxValueFromABIType(pubKey, algosdk.ABIType.from('(uint64,uint64,uint8,uint64)'))).valueOf() as bigint[];

  const metadata: Metadata = {
    start: boxValue[0], end: boxValue[1], uploading: boxValue[2], endSize: boxValue[3],
  };

  const numBoxes = Math.floor(data.byteLength / MAX_BOX_SIZE);
  const boxData: Buffer[] = [];

  for (let i = 0; i < numBoxes; i++) {
    const box = data.subarray(i * MAX_BOX_SIZE, (i + 1) * MAX_BOX_SIZE);
    boxData.push(box);
  }

  boxData.push(data.subarray(numBoxes * MAX_BOX_SIZE, data.byteLength));

  const suggestedParams = await algodClient.getTransactionParams().do();

  const boxPromises = boxData.map(async (box, boxIndexOffset) => {
    const boxIndex = metadata.start + BigInt(boxIndexOffset);
    const numChunks = Math.ceil(box.byteLength / BYTES_PER_CALL);

    const chunks: Buffer[] = [];

    for (let i = 0; i < numChunks; i++) {
      chunks.push(box.subarray(i * BYTES_PER_CALL, (i + 1) * BYTES_PER_CALL));
    }

    const boxRef = { appIndex: 0, name: algosdk.encodeUint64(boxIndex) };
    const boxes: algosdk.BoxReference[] = new Array(7).fill(boxRef);

    boxes.push({ appIndex: 0, name: pubKey });

    const firstGroup = chunks.slice(0, 8);
    const secondGroup = chunks.slice(8);

    const firstAtc = new algosdk.AtomicTransactionComposer();
    firstGroup.forEach((chunk, i) => {
      firstAtc.addMethodCall({
        method: appClient.getABIMethod('upload')!,
        methodArgs: [pubKey, boxIndex, BYTES_PER_CALL * i, chunk],
        boxes,
        suggestedParams,
        sender: sender.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(sender),
        appID,
      });
    });

    await firstAtc.execute(algodClient, 3);

    if (secondGroup.length === 0) return;

    const secondAtc = new algosdk.AtomicTransactionComposer();
    secondGroup.forEach((chunk, i) => {
      secondAtc.addMethodCall({
        method: appClient.getABIMethod('upload')!,
        methodArgs: [pubKey, boxIndex, BYTES_PER_CALL * (i + 8), chunk],
        boxes,
        suggestedParams,
        sender: sender.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(sender),
        appID,
      });
    });

    await secondAtc.execute(algodClient, 3);
  });

  await Promise.all(boxPromises);
  if (Buffer.concat(boxData).toString('hex') !== data.toString('hex')) throw new Error('Data validation failed!');

  await appClient.call({
    method: 'finishUpload',
    methodArgs: [pubKey],
    boxes: [
      pubKey,
    ],
    sendParams: { suppressLog: true },
  });

  return metadata;
}

describe('Algorand DID', () => {
  const bigData = fs.readFileSync(`${__dirname}/TEAL.pdf`);
  const smallJSONObject = { keyOne: 'foo', keyTwo: 'bar' };
  let appClient: ApplicationClient;
  let sender: algosdk.Account;
  const bigDataPubKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;
  const smallDataPubKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;

  beforeAll(async () => {
    sender = await algokit.getDispenserAccount(algodClient, kmdClient);

    appClient = new ApplicationClient({
      resolveBy: 'id',
      id: 0,
      sender,
      app: JSON.stringify(appSpec),
    }, algodClient);

    await appClient.create({ sendParams: { suppressLog: true } });
  });

  describe('uploadDIDDocument', () => {
    it('uploads big (multi-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      await uploadDIDDocument(
        bigData,
        Number(appId),
        bigDataPubKey,
        sender,
      );
    });

    it('uploads small (single-box) data', async () => {
      const { appId } = await appClient.getAppReference();
      const data = Buffer.from(JSON.stringify(smallJSONObject));

      await uploadDIDDocument(
        data,
        Number(appId),
        smallDataPubKey,
        sender,
      );
    });
  });

  describe('resolveDID', () => {
    it('resolves big (multi-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      const addr = algosdk.encodeAddress(bigDataPubKey);

      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`);

      expect(resolvedData.toString('hex')).toEqual(bigData.toString('hex'));
    });

    it('resolves small (single-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      const addr = algosdk.encodeAddress(smallDataPubKey);

      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`);

      expect(resolvedData.toString()).toEqual(JSON.stringify(smallJSONObject));
    });
  });
});
