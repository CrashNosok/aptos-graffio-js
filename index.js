import { AptosClient, AptosAccount, CoinClient } from "aptos";
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import { Buffer } from "buffer";
import { config } from "./config.js";
import consoleStamp from 'console-stamp';
import fs from 'fs'

consoleStamp(console, { format: ':date(HH:MM:ss)' });

const lengthStart = 0
const lengthStop = 999
const weightStart = 0
const weightStop = 999

class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }

    equals(otherPoint) {
        return this.x === otherPoint.x && this.y === otherPoint.y;
      }
}

const parseFile = fileName => fs.readFileSync(fileName, "utf8").split('\n').map(str => str.trim()).filter(str => str.length > 10);
const generateRandomNumber = (min, max) => Math.round(Math.random() * (max - min) + min);
const timeout = ms => new Promise(res => setTimeout(res, ms))

const client = new AptosClient(config.rpc);
const coinClient = new CoinClient(client)
const retriesMap = new Map();

function handleRetries(address) {
    let maxRetries = config.retries;
    let count = retriesMap.get(address) + 1 || 1;
    retriesMap.set(address, count);

    return count < maxRetries
}

async function submitTransactionProxy(signedTxn, proxy) {
    const headers = { 'Content-Type': 'application/x.aptos.signed_transaction+bcs' };
    const proxyAgent = new HttpsProxyAgent(proxy);
    const requestOptions = {
        method: 'POST',
        headers: headers,
        body: signedTxn,
        agent: proxyAgent,
    };
    
    try {
        const response = await fetch(`${config.rpc}/transactions`, requestOptions);
    
        if (response.status >= 400) {
          const errorText = await response.text();
          throw new Error(`ApiError: ${errorText}, Status Code: ${response.status}`);
        }
    
        const responseData = await response.json();
        return responseData;
      } catch (error) {
        throw error;
      }
}

async function getTransactionByHash(txnHash, proxy) {
    const proxyAgent = new HttpsProxyAgent(proxy);
    const requestOptions = {
        method: 'GET',
        agent: proxyAgent,
    };
    const response = await fetch(`${config.rpc}/transactions/by_hash/${txnHash}`, requestOptions);
    if (response.status != 404 && response.status >= 400) {
      throw new Error(`ApiError: ${response.status}`);
    }
    return await response.json();
  }

async function transactionPendingProxy(txnHash, proxy) {
    const response = await getTransactionByHash(txnHash, proxy);
    if (response.status === 404) {
        return true;
    }
    if (response.status >= 400) {
        throw new Error(`ApiError: ${response.text}, Status Code: ${response.status}`);
    }
    return response.type === 'pending_transaction';
}

async function waitForTransactionProxy(txnHash, proxy) {
    let count = 0;
    let response;

    while (await transactionPendingProxy(txnHash, proxy)) {
        if (count >= 50) {
            throw new Error(`Transaction ${txnHash} timed out`);
        }
        await timeout(1000)
        count++;
    }

    response = await getTransactionByHash(txnHash, proxy);
    count = 0;
    while (!response.success) {
        if (count >= 50) {
            throw new Error(`Transaction ${txnHash} timed out`);
        }
        response = await getTransactionByHash(txnHash, proxy);
        await timeout(1000)
        count++;
    }
    if (!response.success) {
        throw new Error(`${response.text} - ${txnHash}`);
    }
    return response
}

async function sendTransaction(sender, payload, proxy) {
    try {
        const txnRequest = await client.generateTransaction(sender.address(), payload, {
            max_gas_amount: generateRandomNumber(700, 2000),
        });
        const signedTxn = await client.signTransaction(sender, txnRequest);

        const transactionRes = await submitTransactionProxy(signedTxn, proxy);

        let txnHash = transactionRes?.hash

        console.log(`tx: https://explorer.aptoslabs.com/txn/${txnHash}?network=mainnet`);

        let status = await waitForTransactionProxy(txnHash, proxy)
    } catch (err) {
        try {
            console.log('[ERROR]', JSON.parse(err?.message).message)
        } catch { console.log('[ERROR]', err.message) }

        if (handleRetries(sender.address().toString())) {
            await timeout(10000)
            return await sendTransaction(sender, payload)
        }
    }
}


async function drawGraffiti(sender, payload, proxy) {
    console.log(`Drawing ${payload[1].length} pixels`);

    return await sendTransaction(
        sender, {
            function: "0x915efe6647e0440f927d46e39bcb5eb040a7e567e1756e002073bc6e26f2cd23::canvas_token::draw",
            type_arguments: [],
            arguments: payload
        }, 
        proxy
    )
}

function generatePayload(pointsArray) {
    let axisX = [], axisY = [], colors = [];

    for (let point of pointsArray) {
        axisX.push(point.x);
        axisY.push(point.y);
        colors.push(generateRandomNumber(0, 7))
    }

    return ["0x5d45bb2a6f391440ba10444c7734559bd5ef9053930e3ef53d05be332518522b", axisX, axisY, colors]
}

async function checkBalance(account) {
    try {
        let balance = Number(await coinClient.checkBalance(account)) / 100000000;
        console.log(`Balance ${balance} APT`);

        return balance
    } catch (err) {
        try {
            if (JSON.parse(err?.message).message.includes('Resource not found')) {
                console.log(`Balance 0 APT`);
                return 0
            } else console.log('[ERROR]', JSON.parse(err?.message).message)
        } catch {
            console.log('[ERROR]', err.message)
        }

        if (handleRetries(sender.address().toString())) {
            await timeout(2000)
            return await checkBalance(account)
        }
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function getPossibleDirections(usedPoints) {
    const currentPoint = usedPoints[usedPoints.length - 1];
  
    const pointsAround = [
        new Point(currentPoint.x + 1, currentPoint.y),
        new Point(currentPoint.x + 1, currentPoint.y - 1),
        new Point(currentPoint.x, currentPoint.y - 1),
        new Point(currentPoint.x - 1, currentPoint.y - 1),
        new Point(currentPoint.x - 1, currentPoint.y),
        new Point(currentPoint.x - 1, currentPoint.y + 1),
        new Point(currentPoint.x, currentPoint.y + 1),
        new Point(currentPoint.x + 1, currentPoint.y + 1),
    ];
  
    shuffleArray(pointsAround);
  
    for (const point of pointsAround) {
      if (
        !usedPoints.some(usedPoint => usedPoint.equals(point)) &&
        weightStop >= point.x >= weightStart &&
        lengthStop >= point.y >= lengthStart
      ) {
        return point;
      }
    }
  
    return null;
  }

function createLine(maxLineLength) {
    const resultPoints = [];
  
    const lineLength = Math.floor(Math.random() * maxLineLength) + 1;
    const x = Math.floor(Math.random() * (lengthStop - lengthStart + 1)) + lengthStart;
    const y = Math.floor(Math.random() * (weightStop - weightStart + 1)) + weightStart;
    resultPoints.push(new Point(x, y));
  
    while (resultPoints.length < lineLength) {
      const nextPoint = getPossibleDirections(resultPoints);
      if (nextPoint === null) {
        break;
      }
      resultPoints.push(nextPoint);
    }
  
    return resultPoints;
  }

function getPointsForDraw() {
    const countLines = Math.floor(Math.random() * 4) + 1;
    const listMaxSize = generateRandomNumber(config.pixelsCount.from, config.pixelsCount.to);
    const maxLineLength = Math.floor(listMaxSize / countLines);
    const resultArr = [];
  
    for (let i = 0; i < countLines; i++) {
      const line = createLine(maxLineLength);
      resultArr.push(...line);
    }
  
    return resultArr.slice(0, listMaxSize);
  }

(async () => {
    let privateKeys = parseFile('wallets.txt');
    let proxies = parseFile('proxy.txt');
    let i = 0;

    while (privateKeys.length) {
        let pk = privateKeys[i]
        let proxy = proxies[i]

        if (!proxy.includes('://')) {
            proxy = 'http://' + proxy
        }

        if (pk.startsWith('0x'))
            pk = pk.slice(2, pk.length);

        const account = new AptosAccount(Uint8Array.from(Buffer.from(pk, 'hex')));
        const balance = await checkBalance(account)

        if (balance > 0) {
            const points = getPointsForDraw();
            const payload = generatePayload(points);
            await drawGraffiti(account, payload, proxy);
            console.log("-".repeat(130));
            await timeout(config.sleep)
        }

        i++;

        if (i >= privateKeys.length)
            i = 0;
    }
})()
