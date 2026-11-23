import { ethers } from "ethers";

type Log = { address: string; data: string; topics: readonly string[] };
const erc20 = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const exchange = new ethers.Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
]);
const erc1155 = new ethers.Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function collateralNet(
  logs: readonly Log[],
  token: string,
  owner: string,
) {
  let net = 0n;
  for (const log of logs) {
    if (!eq(log.address, token)) continue;
    try {
      const event = erc20.parseLog(log);
      if (!event) continue;
      if (eq(String(event.args.to), owner)) net += BigInt(event.args.value);
      if (eq(String(event.args.from), owner)) net -= BigInt(event.args.value);
    } catch {
      /* unrelated event from token */
    }
  }
  return net;
}

export function positionNet(
  logs: readonly Log[],
  contract: string,
  tokenId: string,
  owner: string,
) {
  let net = 0n;
  for (const log of logs) {
    if (!eq(log.address, contract)) continue;
    try {
      const event = erc1155.parseLog(log);
      if (!event) continue;
      const ids =
        event.name === "TransferSingle" ? [event.args.id] : event.args.ids;
      const values =
        event.name === "TransferSingle" ? [event.args.value] : event.args[4];
      for (let index = 0; index < ids.length; index++) {
        if (String(ids[index]) !== tokenId) continue;
        if (eq(String(event.args.to), owner)) net += BigInt(values[index]);
        if (eq(String(event.args.from), owner)) net -= BigInt(values[index]);
      }
    } catch {
      /* unrelated event from token */
    }
  }
  return net;
}

export function houseTradeReceipt(
  logs: readonly Log[],
  input: {
    hash: string;
    exchange: string;
    owner: string;
    tokenId: string;
    collateral: string;
    ledger: string;
    side: "BUY" | "SELL";
  },
) {
  let shares = 0n,
    maker = 0n;
  for (const log of logs) {
    if (!eq(log.address, input.exchange)) continue;
    try {
      const event = exchange.parseLog(log);
      if (!event || !eq(String(event.args.maker), input.owner)) continue;
      if (
        !eq(String(event.args.orderHash), input.hash) ||
        String(event.args.tokenId) !== input.tokenId ||
        Number(event.args.side) !== (input.side === "BUY" ? 0 : 1)
      )
        return null;
      shares += BigInt(
        input.side === "BUY"
          ? event.args.takerAmountFilled
          : event.args.makerAmountFilled,
      );
      maker += BigInt(event.args.makerAmountFilled);
    } catch {
      return null;
    }
  }
  const net = collateralNet(logs, input.collateral, input.owner);
  const position = positionNet(logs, input.ledger, input.tokenId, input.owner);
  if (
    shares <= 0n ||
    (input.side === "BUY"
      ? net >= 0n || position <= 0n || position > shares
      : net <= 0n || -position !== shares)
  )
    return null;
  return { shares: input.side === "BUY" ? position : shares, cash: net, maker };
}
