#!/usr/bin/env node
// This script places an order (stop or limit-based) and once filled, places a stop for 50% and an
//  OCO limit+stop order for the other 50% at 1:1 risk/reward to eliminate risk from your trade early
//  https://github.com/cryptomius/Bitfinex-Auto-Stop-121-Scale-Out
require('dotenv').config()
const { argv } = require('yargs')
  .usage('Usage: $0')
  .example('$0 -p BTCUSD -a 0.004 -e 10000 -s 9000', 'Place a long market stop entry order for 0.004 BTC @ 10000 USD with stop at 9000 USD and default 1:1 50% scale-out target.')
// '-p <tradingPair>'
  .demand('pair')
  .alias('p', 'pair')
  .describe('p', 'Set trading pair eg. BTCUSD')
// '-a <tradeAmount>'
  .demand('amount')
  .number('a')
  .alias('a', 'amount')
  .describe('a', 'Set amount to buy/sell')
// '-e <entryPrice>'
  .number('e')
  .alias('e', 'entry')
  .describe('e', 'Set entry price (exclude for market price)')
  .default('e', 0)
// '-s <stopPrice>'
  .demand('stop')
  .number('s')
  .alias('s', 'stop')
  .describe('s', 'Set stop price')
// '-S <estimatedSlippagePercent>'
  .number('S')
  .alias('S', 'slippage')
  .describe('S', 'Estimated slippage percentage on stop order. Set to factor estimated slippage into target price for risk-free scale out.')
  .default('S', 0)
// '-l' for limit-order entry
  .boolean('l')
  .alias('l', 'limit')
  .describe('l', 'Place limit-order instead of a market stop-order entry (ignored if entryPrice is 0)')
  .default('l', false)
// '-t' for stop limit entry trigger price
  .number('t')
  .alias('t', 'trigger')
  .describe('t', 'Trigger price for stop-limit entry')
  .default('t', 0)
// '-x' for exchange trading
  .boolean('x')
  .alias('x', 'exchange')
  .describe('x', 'Trade on exchange instead of margin')
  .default('x', false)
// '-h' for hidden exit orders
  .boolean('h')
  .alias('h', 'hideexit')
  .describe('h', 'Hide your target and stop orders from the orderbook')
  .default('h', false)
// '-c <cancelPrice>' price at which to cancel entry order if breached.
  .number('c')
  .alias('c', 'cancel-price')
  .describe('c', 'Set price at which to cancel entry order if breached (defaults to stop price)')
  .default('c', 0)
// '-n <disableScaleOut>' skip scale-out.
  .boolean('n')
  .alias('n', 'disable-scale-out')
  .describe('n', 'Disable scale-out (100% stop only)')
  .default('n', false)
  .wrap(process.stdout.columns)

let {
  p: tradingPair, a: tradeAmount, e: entryPrice, s: stopPrice, S: slippage, l: entryLimitOrder,
  t: entryStopLimitTrigger, x: isExchange, h: hiddenExitOrders, c: cancelPrice, n: noScaleOut
} = argv

const { createLogger, format, transports } = require('winston')

const loggerFormat = format.printf(info => `${info.timestamp} - ${JSON.stringify(info.message)}`)

const logPath = `${process.env.LOGBASEPATH || ''}${tradingPair}-${new Date()}.log`

const moment = require('moment')

let lastPriceUpdate

const options = {
  console: {
    level: 'debug',
    handleExceptions: true,
    format: format.combine(
      format.timestamp(),
      loggerFormat
    )
  },
  file: {
    level: 'info',
    filename: `${logPath}`,
    handleExceptions: true,
    format: format.combine(
      format.timestamp(),
      format.json()
    )
  }
}

const logger = createLogger({
  transports: [
    new transports.Console(options.console),
    new transports.File(options.file)
  ]
})

logger.info('1:1 scale out mode: ' + (noScaleOut ? 'OFF' : 'ON'))

const bfxExchangeTakerFee = 0.002 // 0.2% 'taker' fee

var roundToSignificantDigitsBFX = function (num) {
  // Bitfinex uses 5 significant digits
  // https://support.bitfinex.com/hc/en-us/articles/115000371105-How-is-precision-calculated-using-Significant-Digits
  var n = 5
  if (num === 0) { return 0 }
  var d = Math.ceil(Math.log10(num < 0 ? -num : num))
  var power = n - d
  var magnitude = Math.pow(10, power)
  var shifted = Math.round(num * magnitude)
  return shifted / magnitude
}

const BFX = require('bitfinex-api-node')
const { Order } = require('bfx-api-node-models')

const { API_KEY, API_SECRET } = process.env

const bfx = new BFX({
  apiKey: API_KEY,
  apiSecret: API_SECRET,

  ws: {
    autoReconnect: true,
    seqAudit: false,
    packetWDDelay: 10 * 1000,
    transform: true
  }
})

tradingPair = tradingPair.toUpperCase()
entryPrice = roundToSignificantDigitsBFX(entryPrice)
stopPrice = roundToSignificantDigitsBFX(stopPrice)
tradeAmount = roundToSignificantDigitsBFX(tradeAmount)
cancelPrice = cancelPrice ? roundToSignificantDigitsBFX(cancelPrice) : stopPrice

let isShort = entryPrice < stopPrice
let estimatedSlippagePercent = slippage / 100

var entryOrderActive = false

let entryOrderObj = {
  cid: Date.now(),
  symbol: 't' + tradingPair,
  price: entryPrice,
  amount: !isShort ? tradeAmount : -tradeAmount,
  type: Order.type[(isExchange ? 'EXCHANGE_' : '') + (entryPrice === 0 ? 'MARKET' : entryLimitOrder ? 'LIMIT' : entryStopLimitTrigger === 0 ? 'STOP' : 'STOP_LIMIT')]
}
if (entryStopLimitTrigger !== 0) { // stop limit entry
  entryOrderObj['price'] = roundToSignificantDigitsBFX(entryStopLimitTrigger)
  entryOrderObj['priceAuxLimit'] = entryPrice
  logger.info('entryStopLimitTrigger = ' + entryStopLimitTrigger + ' entryPrice = ' + entryPrice)
}

const ws = bfx.ws(2)
const o = new Order(entryOrderObj)

ws.on('error', (err) => logger.error(`a websocket error occured ${err}`))
ws.on('open', () => {
  ws.subscribeTicker('t' + tradingPair)
  logger.info('Monitoring ' + tradingPair + ' for breach of cancel price: ' + cancelPrice)
  ws.auth()
})

ws.onTicker({ symbol: 't' + tradingPair }, (ticker) => {
  let tickerObj = ticker.toJS()
  if (entryOrderActive) {
    if (!lastPriceUpdate || moment().diff(lastPriceUpdate, 'minute') > 5) {
      logger.info(`${tradingPair} price: ${roundToSignificantDigitsBFX(tickerObj.lastPrice)} (ask: ${tickerObj.ask}, bid: ${tickerObj.bid}) ${isShort ? 'sell' : 'buy'}: ${entryStopLimitTrigger || entryPrice} cancel: ${cancelPrice}`)
      lastPriceUpdate = moment()
    }

    if ((entryPrice > cancelPrice && tickerObj.bid <= cancelPrice) || (entryPrice < cancelPrice && tickerObj.ask >= cancelPrice)) {
      // Cancel the entry order if the cancel price is breached hit prior to entry
      logger.info('Your cancel price of ' + cancelPrice + ' was breached prior to entry. Cancelling entry order.')
      o.cancel().then(() => {
        logger.info(`Cancellation confirmed for order ${o.cid}`)
        ws.close()
        process.exit()
      }).catch((err) => {
        logger.error(`WARNING - error cancelling order: ${err}`)
        ws.close()
        process.exit()
      })
    }
  }
})

ws.once('auth', () => {
  // Enable automatic updates
  o.registerListeners(ws)

  o.on('update', () => {
    logger.info(`Order updated: ${o.serialize()}`)
  })

  o.on('close', () => {
    logger.info(`Order status: ${o.status}`)

    if (o.status !== 'CANCELED') {
      entryOrderActive = false
      ws.unsubscribeTicker('t' + tradingPair)
      logger.info('-- POSITION ENTERED --')
      if (isExchange) { tradeAmount = tradeAmount - (tradeAmount * bfxExchangeTakerFee) }
      if ((noScaleOut === true) || (o.priceAvg == null && entryPrice === 0)) {
        let amount4 = roundToSignificantDigitsBFX((!isShort ? -tradeAmount : tradeAmount))
        if (noScaleOut !== true) {
          logger.info(' Average price of entry was NOT RETURNED by Bitfinex! Scale-out target cannot be calculated. :-(')
          logger.info(' Placing a SINGLE stop order at ' + stopPrice + ' for ' + amount4 + ' (100%) to protect your position')

          logger.info('Please send this to @cryptomius to help debug:')
          logger.info(argv)
          logger.info(o)
        } else {
          // no 1:1 scale out (noScaleOut == true)
          logger.info(' Placing a SINGLE stop order at ' + stopPrice + ' for ' + amount4 + ' (100%) to protect your position')
        }

        const o4 = new Order({
          cid: Date.now(),
          symbol: 't' + tradingPair,
          price: stopPrice,
          amount: amount4,
          hidden: hiddenExitOrders,
          type: Order.type[(isExchange ? 'EXCHANGE_' : '') + 'STOP']
        }, ws)
        o4.setReduceOnly(true)

        o4.submit().then(() => {
          if (noScaleOut !== true) {
            logger.info('Submitted 100% stop order. YOU MUST REDUCE THIS TO 50% AND CREATE AN oco LIMIT+STOP ORDER MANUALLY.')
          } else {
            logger.info('Submitted 100% stop order.')
          }
          logger.info('------------------------------------------')
          ws.close()
          process.exit()
        }).catch((err) => {
          logger.error(err)
          ws.close()
          process.exit()
        })
      } else {
        let amount1 = roundToSignificantDigitsBFX((!isShort ? -tradeAmount : tradeAmount) / 2)
        const o2 = new Order({
          cid: Date.now(),
          symbol: 't' + tradingPair,
          price: stopPrice,
          amount: amount1,
          hidden: hiddenExitOrders,
          type: Order.type[(isExchange ? 'EXCHANGE_' : '') + 'STOP']
        }, ws)
        o2.setReduceOnly(true)

        logger.info(' Compiled stop order for ' + amount1 + ' at ' + stopPrice)

        o2.submit().then(() => {
          logger.info(' Average price of entry = ' + o.priceAvg)
          entryPrice = o.priceAvg
          logger.info('Submitted 50% stop order')
          let targetPrice = !isShort
            ? (2 * entryPrice) - (stopPrice * (1 - estimatedSlippagePercent)) + (4 * entryPrice * bfxExchangeTakerFee) / (1 - bfxExchangeTakerFee)
            : (2 * entryPrice) - (stopPrice * (1 + estimatedSlippagePercent)) - (4 * entryPrice * bfxExchangeTakerFee) / (1 + bfxExchangeTakerFee)
          targetPrice = roundToSignificantDigitsBFX(targetPrice)
          let amount2 = roundToSignificantDigitsBFX((!isShort ? -tradeAmount : tradeAmount) / 2)

          const o3 = new Order({
            cid: Date.now(),
            symbol: 't' + tradingPair,
            price: targetPrice, // scale-out target price (1:1)
            amount: amount2,
            type: Order.type[(isExchange ? 'EXCHANGE_' : '') + 'LIMIT'],
            oco: true,
            hidden: hiddenExitOrders,
            priceAuxLimit: stopPrice
          }, ws)
          o3.setReduceOnly(true)

          logger.info(' Compiled oco limit order for ' + amount2 + ' at ' + targetPrice + ' and stop at ' + stopPrice)

          o3.submit().then(() => {
            logger.info('Submitted 50% 1:1 + stop (oco) limit order')
            logger.info('------------------------------------------')
            logger.info('Good luck! Making gains? Drop me a tip! :-) PayPal: https://www.paypal.me/sydneyshan Crypto: https://tinyurl.com/bfx121')
            logger.info('------------------------------------------')
            ws.close()
            process.exit()
          })
        }).catch((err) => {
          logger.error(err)
          ws.close()
          process.exit()
        })
      }
    } else {
      logger.info('Entry order cancelled.')
      ws.close()
      process.exit()
    }
  })

  o.submit().then(() => {
    entryOrderActive = true
    logger.info(`submitted entry order ${o.id}`)
  }).catch((err) => {
    logger.error(err)
    process.exit()
  })
})

if (isExchange && isShort) {
  logger.info('You must use margin=true if you want to go short.')
  process.exit()
} else {
  ws.open()
}

// safety mechanism - cancel order if process is interrupted.
process.once('SIGINT', function (code) {
  logger.error(`handled script interrupt - code ${code}.`)
  cancelOrderAndExit()
})

process.once('SIGTERM', function (code) {
  logger.error(`handled script interrupt - code ${code}.`)
  cancelOrderAndExit()
})

process.once('SIGHUP', function (code) {
  logger.error(`handled script interrupt - code ${code}.`)
  cancelOrderAndExit()
})

function cancelOrderAndExit () {
  if (entryOrderActive) {
    o.cancel().then(() => {
      logger.info(`Cancellation confirmed for order ${o.cid}`)
      entryOrderActive = false
      ws.close()
      process.exit()
    })
  } else {
    ws.close()
    process.exit()
  }
}
