import gql from "graphql-tag";

import { TruffleDB } from "truffle-db/db";

import * as Contracts from "truffle-workflow-compile";

import { generateId } from "test/helpers";

const GetContractNames = gql`
query GetContractNames {
  artifacts {
    contractNames
  }
}
`;

const GetBytecode = gql`
query GetBytecode($name: String!) {
  artifacts {
    contract(name: $name) {
      constructor {
        createBytecode {
          bytes
        }
      }
    }
  }
}
`;

const AddBytecodes = gql`
input BytecodeInput {
  bytes: Bytes!
}

mutation AddBytecodes($bytecodes: [BytecodeInput!]!) {
  workspace {
    bytecodesAdd(input: {
      bytecodes: $bytecodes
    }) {
      bytecodes {
        id
      }
    }
  }
}`;

const GetSource = gql`
query GetSource($name: String!) {
  artifacts {
    contract(name: $name) {
      sourceContract {
        source {
          contents
          sourcePath
        }
      }
    }
  }
}
`;

const AddSources = gql`
input SourceInput {
      contents: String!
      sourcePath: String
}

mutation AddSource($sources: [SourceInput!]!) {
  workspace {
    sourcesAdd(input: {
      sources: $sources
    }) {
      sources {
        id
        contents
        sourcePath
      }
    }
  }
}`;

const AddCompilations = gql`
mutation AddCompilation($contractName: String!, $compilerName: String!, $compilerVersion: String!, $sourceId: ID!, $ast:String!) {
  compilationsAdd(input: {
    compilations: [{
      compiler: {
        name: $compilerName
        version: $compilerVersion
      }
      contracts: [
      {
        name: $contractName,
        ast: {
          json: $ast
        }
        source: {
          id: $sourceId
        }
      }]
      sources: [
        {
         id: $sourceId
        }
      ]
    }]
  }) {
    compilations {
      id
      compiler {
        name
      }
      sources {
        contents
      }
      contracts {
        source {
          contents
          sourcePath
        }
        ast {
          json
        }
        name
      }
    }
  }
}`

// const config =  {
//   contracts_directory: "/Users/fainashalts/pet-shop-tutorial/contracts",
//   contracts_build_directory: "/Users/fainashalts/pet-shop-tutorial/build/contracts", 
//   all: true
// } 

// const config =  {
//   contracts_directory: "/Users/fainashalts/pet-shop-tutorial/contracts",
//   contracts_build_directory: "/Users/fainashalts/pet-shop-tutorial/build/contracts", 
//   all: true
// } 

export class ArtifactsLoader {
  private db: TruffleDB;
  private config: object;

  constructor (db: TruffleDB, config: object) {
    this.db = db;
    this.config = config;
  }

  async load (): Promise<void> {
    const {
      data: {
        artifacts: {
          contractNames
        }
      }
    } = await this.db.query(GetContractNames);

    await this.loadBytecodes(contractNames);
    await this.loadSources(contractNames);
    if(Object.keys(this.config).length) {
      await this.loadCompilations(this.config);
    }
// console.debug("config " + JSON.stringify(this.config));
//     await this.loadCompilations(this.config);

  }

  async loadBytecodes(contractNames: string[]) {
    const createBytecodes = await Promise.all(contractNames.map(
      async (name) =>
        (await this.db.query(GetBytecode, { name }))
          .data
          .artifacts
          .contract
          .constructor
          .createBytecode
    ));

    const bytecodes = [...createBytecodes];

    await this.db.query(AddBytecodes, { bytecodes });
  }

  async loadSources(contractNames: string[]) {
    const contractSources = await Promise.all(contractNames.map(
      async (name) =>
        (await this.db.query(GetSource, { name }))
          .data
          .artifacts
          .contract
          .sourceContract
          .source
    ));

    const sources = [...contractSources];

    await this.db.query(AddSources, { sources });
  }
  
  async loadCompilations(config) {
    let compilationsArray = [];
    let sources = [];
console.debug("in here and here is config " + JSON.stringify(config, null, 2));
    Contracts.compile(config, (err, output) => {
      console.debug("in here too and here is the output " + JSON.stringify(output));
      if(err) console.error(err);
      else {
        const compilationsData = Object.values(output.contracts);
        //have to add sources since they are referenced by id in compilation input
        const compilationSources = compilationsData.map(
          async (contract) => {
            console.debug("contract " + JSON.stringify(contract, null, 2));
            let sourceObject = {
              contents: contract["source"], 
              sourcePath: contract["sourcePath"]
            };

            sources.push({contents: contract["source"], sourcePath: contract["sourcePath"]})
            console.debug("sources " + JSON.stringify(sources));
            let compilationObject = {
              contractName: contract["contract_name"],
              compilerName: contract["compiler"]["name"],
              compilerVersion: contract["compiler"]["version"],
              sourceId: generateId({contents: contract["source"], sourcePath: contract["sourcePath"]}),
              ast: contract["ast"],
            }
            compilationsArray.push(compilationObject);
          }
        )
      }  
      
    });

    const addSource = await this.db.query(AddSources, { sources });
    await this.db.query(AddCompilations, { compilationsArray })
  }
}
