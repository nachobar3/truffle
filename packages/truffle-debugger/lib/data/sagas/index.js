import debugModule from "debug";
const debug = debugModule("debugger:data:sagas"); // eslint-disable-line no-unused-vars

import { put, takeEvery, select, call, putResolve } from "redux-saga/effects";
import jsonpointer from "json-pointer";

import { prefixName, stableKeccak256 } from "lib/helpers";

import { TICK } from "lib/trace/actions";
import * as actions from "../actions";

import data from "../selectors";

import * as DecodeUtils from "truffle-decode-utils";

import { getStorageAllocations } from "truffle-decoder";

export function* scope(nodeId, pointer, parentId, sourceId) {
  yield putResolve(actions.scope(nodeId, pointer, parentId, sourceId));
}

export function* declare(node) {
  yield putResolve(actions.declare(node));
}

export function* defineType(node) {
  yield putResolve(actions.defineType(node));
}

function* tickSaga() {
  let { tree, id: treeId, node, pointer } = yield select(data.views.ast);

  let decode = yield select(data.views.decoder);
  let scopes = yield select(data.views.scopes.inlined);
  let allocations = yield select(data.info.allocations.storage);
  let currentAssignments = yield select(data.proc.assignments);
  let currentDepth = yield select(data.current.functionDepth);
  let address = yield select(data.current.address); //may be undefined
  let dummyAddress = yield select(data.current.dummyAddress);

  let stack = yield select(data.next.state.stack);
  if (!stack) {
    return;
  }

  let top = stack.length - 1;
  var parameters, returnParameters, assignment, assignments;

  if (!node) {
    return;
  }

  // stack is only ready for interpretation after the last step of each
  // source range
  //
  // the data module always looks at the result of a particular opcode
  // (i.e., the following trace step's stack/memory/storage), so this
  // asserts that the _current_ operation is the final one before
  // proceeding
  if (!(yield select(data.views.atLastInstructionForSourceRange))) {
    return;
  }

  switch (node.nodeType) {
    case "FunctionDefinition":
      parameters = node.parameters.parameters.map(
        (p, i) => `${pointer}/parameters/parameters/${i}`
      );

      returnParameters = node.returnParameters.parameters.map(
        (p, i) => `${pointer}/returnParameters/parameters/${i}`
      );

      assignments = {
        byId: Object.assign(
          {},
          ...returnParameters
            .concat(parameters)
            .reverse()
            .map(pointer => jsonpointer.get(tree, pointer).id)
            //note: depth may be off by 1 but it doesn't matter
            .map((id, i) =>
              makeAssignment(
                { astId: id, stackframe: currentDepth },
                { stack: top - i }
              )
            )
            .map(assignment => ({ [assignment.id]: assignment }))
        )
      };
      debug("Function definition case");
      debug("assignments %O", assignments);

      yield put(actions.assign(treeId, assignments));
      break;

    case "ContractDefinition":
      let allocation = allocations[node.id];

      debug("Contract definition case");
      debug("allocations %O", allocations);
      debug("allocation %O", allocation);
      assignments = { byId: {} };
      for (let id in allocation.members) {
        id = Number(id); //not sure why we're getting them as strings, but...
        let idObj;
        if (address !== undefined) {
          idObj = { astId: id, address };
        } else {
          idObj = { astId: id, dummyAddress };
        }
        let fullId = stableKeccak256(idObj);
        //we don't use makeAssignment here as we had to compute the ID anyway
        assignment = {
          ...idObj,
          id: fullId,
          ref: {
            ...((currentAssignments.byId[fullId] || {}).ref || {}),
            ...allocation.members[id].pointer
          }
        };
        assignments.byId[fullId] = assignment;
      }
      debug("assignments %O", assignments);

      yield put(actions.assign(treeId, assignments));
      break;

    case "VariableDeclaration":
      let varId = jsonpointer.get(tree, pointer).id;
      debug("Variable declaration case");
      debug("currentDepth %d varId %d", currentDepth, varId);

      //NOTE: We're going to make the assignment conditional here; here's why.
      //There's a bug where calling the autogenerated accessor for a public
      //contract variable causes the debugger to see two additional
      //declarations for that variable... which this code reads as local
      //variable declarations.  Rather than prevent this at the source, we're
      //just going to check for it here, by not adding a local variable if said
      //variable is already a contract variable.

      if (
        currentAssignments.byAstId[varId] !== undefined &&
        currentAssignments.byAstId[varId].some(
          id =>
            currentAssignments.byId[id].address !== undefined ||
            currentAssignments.byId[id].dummyAddress !== undefined
        )
      ) {
        break;
      }

      //otherwise, go ahead and make the assignment
      assignment = makeAssignment(
        { astId: varId, stackframe: currentDepth },
        { stack: top }
      );
      assignments = { byId: { [assignment.id]: assignment } };
      yield put(actions.assign(treeId, assignments));
      break;

    case "IndexAccess":
      // to track `mapping` types known indices

      let baseExpression = node.baseExpression;
      let baseDeclarationId = baseExpression.referencedDeclaration;
      let indexDefinition = node.indexExpression;
      let indexId = indexDefinition.id;

      let baseDeclaration = scopes[baseDeclarationId].definition;

      //if we're not dealing with a mapping, don't bother!
      if (!DecodeUtils.Definition.isMapping(baseExpression)) {
        break;
      }

      debug("Index access case");

      let keyDefinition =
        baseDeclaration.keyType || baseDeclaration.typeName.keyType;

      yield put(actions.mapKeyDecoding(true));

      //indices need to be identified by stackframe
      let indexIdObj = { astId: indexId, stackframe: currentDepth };
      let fullIndexId = stableKeccak256(indexIdObj);

      const indexReference = (currentAssignments.byId[fullIndexId] || {}).ref;
      let indexValue;
      if (indexReference) {
        //in general, we want to decode using the key definition, not the index
        //definition. however, the key definition may have the wrong location
        //on it.  so, when applicable, we splice the index definition location
        //onto the key definition location.
        let splicedDefinition;
        if (DecodeUtils.Definition.isReference(indexDefinition)) {
          splicedDefinition = DecodeUtils.Definition.spliceLocation(
            keyDefinition,
            DecodeUtils.Definition.referenceType(indexDefinition)
          );
        } else {
          splicedDefinition = keyDefinition;
        }
        indexValue = yield call(decode, splicedDefinition, indexReference);
      } else if (DecodeUtils.Definition.isConstantType(indexDefinition)) {
        //constant expression are not always sourcemapped to, meaning we won't
        //find a prior assignment for them. so we will have to just construct
        //the ConstantDefinitionPointer ourselves.
        indexValue = yield call(decode, keyDefinition, {
          definition: indexDefinition
        });
      }

      debug("index value %O", indexValue);
      debug("keyDefinition %O", keyDefinition);

      //if we didn't find it and it's not a constant type... ignore it
      if (indexValue !== undefined) {
        yield put(actions.mapKey(baseDeclarationId, indexValue));
      }

      yield put(actions.mapKeyDecoding(false));

      break;

    case "Assignment":
      break;

    default:
      if (node.typeDescriptions == undefined) {
        break;
      }

      debug("decoding expression value %O", node.typeDescriptions);
      let literal = stack[top];

      debug("default case");
      debug("currentDepth %d node.id %d", currentDepth, node.id);
      assignment = makeAssignment(
        { astId: node.id, stackframe: currentDepth },
        { literal }
      );
      assignments = { byId: { [assignment.id]: assignment } };
      yield put(actions.assign(treeId, assignments));
      break;
  }
}

export function* reset() {
  yield put(actions.reset());
}

export function* learnAddressSaga(dummyAddress, address) {
  debug("about to learn an address");
  yield put(actions.learnAddress(dummyAddress, address));
  debug("address learnt");
}

export function* recordAllocations() {
  let contracts = yield select(data.views.userDefinedTypes.contractDefinitions);
  debug("contracts %O", contracts);
  let referenceDeclarations = yield select(data.views.referenceDeclarations);
  debug("referenceDeclarations %O", referenceDeclarations);
  let storageAllocations = getStorageAllocations(
    referenceDeclarations,
    contracts
  );
  debug("storageAllocations %O", storageAllocations);
  yield put(actions.allocate(storageAllocations));
}

function makeAssignment(idObj, ref) {
  let id = stableKeccak256(idObj);
  return { ...idObj, id, ref };
}

export function* saga() {
  yield takeEvery(TICK, function*() {
    try {
      yield* tickSaga();
    } catch (e) {
      debug("ERROR: %O", e);
    }
  });
}

export default prefixName("data", saga);
