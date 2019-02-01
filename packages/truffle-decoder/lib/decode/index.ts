import debugModule from "debug";
const debug = debugModule("decoder:decode");

import decodeValue from "./value";
import decodeMemory from "./memory";
import decodeStorage from "./storage";
import { decodeStack, decodeLiteral } from "./stack";
import { AstDefinition } from "truffle-decode-utils";
import * as Pointer from "../types/pointer";
import { EvmInfo } from "../types/evm";
import Web3 from "web3";

export default async function decode(definition: AstDefinition, pointer: Pointer.DataPointer, info: EvmInfo, web3?: Web3, contractAddress?: string): Promise<any> {
  debug("Decoding %s", definition.name);

  if(Pointer.isStoragePointer(pointer)) {
    return await decodeStorage(definition, pointer, info, web3, contractAddress)
  }

  if(Pointer.isMemoryPointer(pointer)) {
    return await decodeMemory(definition, pointer, info);
    //memory does not need web3 & contractAddress
  }

  if(Pointer.isStackPointer(pointer)) {
    return await decodeStack(definition, pointer, info, web3, contractAddress);
    //stack may contain pointer to storage so may need web3 & contractAddress
  }

  if (Pointer.isStackLiteralPointer(pointer)) {
    return await decodeLiteral(definition, pointer, info, web3, contractAddress);
    //literal may contain pointer to storage so may need web3 & contractAddress
  }

  if(Pointer.isConstantDefinitionPointer(pointer)) {
    return await decodeValue(definition, pointer, info);
    //in this case we can go straight to decodeValue, no need for anything else
  }

  //the type system means we can't hit this point!
}
