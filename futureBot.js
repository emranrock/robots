const Binance = require('axios');
const crypto = require('crypto');

// API details for Binance Futures Testnet
const apiKey = '2cb9761905f2369190eacda2c20359eb3d85d142b7b85f24059dc29f956716cf';
const apiSecret = 'e3947488b6daa300f7b777cc478dc3db732b2de964cfa39a6546b4502a56ae09';
const baseUrl = 'https://testnet.binancefuture.com';

const qtyPrc = 0.01; // 1% of current price
const slPrc = 0.02; // 1% of current price
const tpPrc = 0.08; // 8% of current price
const TimeFrame = '15m'; // timeframe 1M 5M 1H

let MAShort = 10;
let MALong = 50;

// Helper function to sign requests
function signRequest(queryString) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function hasOpenOrders(symbol) {
    const queryString = `symbol=${symbol}&timestamp=${Date.now()}`;
    const signature = signRequest(queryString);

    try {
        const response = await Binance.get(`${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`, {
            headers: {
                'X-MBX-APIKEY': apiKey,
            },
        });

        return response.data.length > 0; // Returns true if there are open orders
    } catch (error) {
        console.error('Error checking open orders:', error.response ? error.response.data : error.message);
        throw error;
    }
}


async function getSymbolInfo(symbol) {
    const baseUrl = 'https://api.binance.com/api/v3/exchangeInfo';

    try {
        const response = await Binance.get(baseUrl);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

        if (symbolInfo) {
            return {
                tickSize: symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize,
                minPrice: symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').minPrice,
            };
        } else {
            throw new Error('Symbol not found');
        }
    } catch (error) {
        console.error('Error fetching symbol info:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function calculateSLTP(symbol, slPercent, tpPercent) {
    const currentPrice = await getCurrentPrice(symbol);
    const { tickSize } = await getSymbolInfo(symbol);

    const slPrice = currentPrice * (1 - slPercent); // For buy order
    const tpPrice = currentPrice * (1 + tpPercent); // For buy order

    // Round to nearest tick size
    const slPriceRounded = Math.floor(slPrice / tickSize) * tickSize;
    const tpPriceRounded = Math.ceil(tpPrice / tickSize) * tickSize;

    console.log(`Current Price: ${currentPrice}`);
    console.log(`Stop Loss Price (before rounding): ${slPrice}`);
    console.log(`Stop Loss Price (rounded): ${slPriceRounded}`);
    console.log(`Take Profit Price (before rounding): ${tpPrice}`);
    console.log(`Take Profit Price (rounded): ${tpPriceRounded}`);

    return { slPrice: slPriceRounded, tpPrice: tpPriceRounded };
}


// Function to get the current price of a symbol
async function getCurrentPrice(symbol) {
    try {
        const url = `${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`;
        const response = await Binance.get(url);
        return parseFloat(response.data.price);
    } catch (error) {
        console.error('Error fetching current price:', error.response ? error.response.data : error.message);
    }
}

// Function to calculate moving average
async function calculateMovingAverage(symbol, period, limit = 60) {
    const queryString = `symbol=${symbol}&interval=${TimeFrame}&limit=${limit}`;

    try {
        const response = await Binance.get(`${baseUrl}/fapi/v1/klines?${queryString}`);
        const closingPrices = response.data.map(candle => parseFloat(candle[4]));  // Closing prices

        const sum = closingPrices.slice(-period).reduce((acc, price) => acc + price, 0);
        return sum / period;  // Calculate simple moving average
    } catch (error) {
        console.error('Error fetching klines data:', error.response ? error.response.data : error.message);
    }
}

// Function to place an order (BUY or SELL)
async function placeFuturesOrder(symbol, side, quantity, leverage, stopLossPrice, takeProfitPrice) {

    try {
        // Check if there are existing open orders
        const openOrders = await hasOpenOrders(symbol);

        if (openOrders) {
            console.log(`There are existing open orders for ${symbol}. No new orders will be placed.`);
            return; // Exit if there are open orders
        } else {
            const data = {
                symbol: symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity.toFixed(6),  // Round quantity to 6 decimals
                leverage: leverage,
                timestamp: Date.now(),
            };

            const queryString = new URLSearchParams(data).toString();
            const signature = signRequest(queryString);

            try {
                const response = await Binance.post(`${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`, null, {
                    headers: {
                        'X-MBX-APIKEY': apiKey,
                    },
                });
                console.log(`${side} order placed for ${symbol}:`, response.data.orderId);

                // Set Take Profit Order
                await setTakeProfitOrder(symbol, side, quantity, takeProfitPrice);

                // Set Stop Loss Order
                await setStopLossOrder(symbol, side, quantity, stopLossPrice);

                return response.data;
            } catch (error) {
                console.error('Error placing order:', error.response ? error.response.data : error.message);
            }
        }

    } catch (error) {
        console.error('Error placing futures order:', error.message);
    }

}
// Opposite side for take profit
async function setTakeProfitOrder(symbol, side, quantity, takeProfitPrice) {
    //console.log(takeProfitPrice);
    const tpData = {
        symbol: symbol,
        side: side === 'BUY' ? 'SELL' : 'BUY', // Opposite side for take profit
        type: 'LIMIT',
        quantity: quantity.toFixed(6),  // Round quantity to 6 decimals
        price: takeProfitPrice.toFixed(2),  // Round price to 2 decimals
        timeInForce: 'GTC',  // Good 'til canceled
        timestamp: Date.now(),
    };

    const queryString = new URLSearchParams(tpData).toString();
    const signature = signRequest(queryString);

    try {
        const response = await Binance.post(`${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`, null, {
            headers: {
                'X-MBX-APIKEY': apiKey,
            },
        });
        console.log('Take Profit order placed:', response.data.orderId);
    } catch (error) {
        console.error('Error placing Take Profit order:', error.response ? error.response.data : error.message);
    }
}
// stop loss
async function setStopLossOrder(symbol, side, quantity, stopLossPrice) {
    const slData = {
        symbol: symbol,
        side: side === 'BUY' ? 'SELL' : 'BUY', // Opposite side for stop loss
        type: 'STOP_MARKET',
        quantity: quantity.toFixed(6),  // Round quantity to 6 decimals
        stopPrice: stopLossPrice.toFixed(2),  // Round price to 2 decimals
        timestamp: Date.now(),
    };

    const queryString = new URLSearchParams(slData).toString();
    const signature = signRequest(queryString);

    try {
        const response = await Binance.post(`${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`, null, {
            headers: {
                'X-MBX-APIKEY': apiKey,
            },
        });
        console.log('Stop Loss order placed:', response.data.orderId);
    } catch (error) {
        console.error('Error placing Stop Loss order:', error.response ? error.response.data : error.message);
    }
}

// Function to close an open position
async function closePosition(symbol, side, quantity) {
    const data = {
        symbol: symbol,
        side: side === 'BUY' ? 'SELL' : 'BUY',  // Close with opposite side
        type: 'MARKET',
        quantity: quantity.toFixed(6),  // Round quantity to 6 decimals
        timestamp: Date.now(),
    };

    const queryString = new URLSearchParams(data).toString();
    const signature = signRequest(queryString);

    try {
        const response = await Binance.post(`${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`, null, {
            headers: {
                'X-MBX-APIKEY': apiKey,
            },
        });
        console.log(`Position closed for ${symbol}:`, response.data.orderId);
    } catch (error) {
        console.error('Error closing position:', error.response ? error.response.data : error.message);
    }
}

// Function to monitor and close the position if SL or TP is hit
async function monitorPosition(symbol, side, entryPrice, side, sl, tp, quantity) {
    let positionOpen = true;
    let trailingStop = sl;  // Initialize trailing stop

    while (positionOpen) {
        const currentPrice = await getCurrentPrice(symbol);

        // Adjust trailing stop for BUY position
        if (side === 'BUY') {
            // Update trailing stop if current price is higher
            if (currentPrice > entryPrice) {
                trailingStop = Math.max(trailingStop, currentPrice * 0.98);  // Move trailing stop to 2% below the current price
            }
            // Check if stop-loss is hit
            if (currentPrice <= trailingStop) {
                console.log('Trailing Stop-Loss hit, closing position.');
                await closePosition(symbol, side, quantity);  // Close the position
                positionOpen = false;
            }
            // Check if take-profit is hit
            if (currentPrice >= tp) {
                console.log('Take-Profit hit, closing position.');
                await closePosition(symbol, side, quantity);  // Close the position
                positionOpen = false;
            }
        } else {  // For SELL position
            // Update trailing stop if current price is lower
            if (currentPrice < entryPrice) {
                trailingStop = Math.min(trailingStop, currentPrice * 1.02);  // Move trailing stop to 2% above the current price
            }
            // Check if stop-loss is hit
            if (currentPrice >= trailingStop) {
                console.log('Trailing Stop-Loss hit, closing position.');
                await closePosition(symbol, side, quantity);  // Close the position
                positionOpen = false;
            }
            // Check if take-profit is hit
            if (currentPrice <= tp) {
                console.log('Take-Profit hit, closing position.');
                await closePosition(symbol, side, quantity);  // Close the position
                positionOpen = false;
            }
        }

        // Check for break-even
        if ((side === 'BUY' && currentPrice > entryPrice * 1.01) || (side === 'SELL' && currentPrice < entryPrice * 0.99)) {
            console.log('Moving stop-loss to break-even.');
            trailingStop = entryPrice;  // Move stop-loss to entry price for break-even
        }

        // Sleep for a short while before checking the price again
        await new Promise(resolve => setTimeout(resolve, 1000));  // Check every 1 second
    }
}


// Main trading function (Moving Average Strategy) with SL and TP
async function movingAverageStrategy(symbol, leverage) {
    const shortPeriod = MAShort;
    const longPeriod = MALong;

    // Fetch moving averages
    const shortMA = await calculateMovingAverage(symbol, shortPeriod);
    const longMA = await calculateMovingAverage(symbol, longPeriod);
    const currentPrice = await getCurrentPrice(symbol);
    const { tickSize } = await getSymbolInfo(symbol);
    console.log(`${symbol} for Short MA: ${shortMA}, Long MA: ${longMA}, Current Price: ${currentPrice} tick size: ${tickSize}`);

    const quantity = qtyPrc;  // Example fixed quantity; you can add quantity calculation logic here
    const slMultiplier = slPrc;  // Stop-Loss % below or above the entry price
    const tpMultiplier = tpPrc;  // Take-Profit % above or below the entry price


    if (shortMA > longMA && currentPrice > shortMA) {
        console.log('Buy signal detected.');
        const entryPrice = currentPrice;
        const slPrice = entryPrice * (1 - slMultiplier); // Stop-Loss 2% below entry price
        const tpPrice = entryPrice * (1 + tpMultiplier); // Take-Profit 5% above entry price

        // Round to nearest tick size
        const slPriceRounded = Math.floor(slPrice / tickSize) * tickSize;
        //const tpPriceRounded = Math.ceil(tpPrice / tickSize) * tickSize;
        const tpPriceRounded = Math.floor(tpPrice / tickSize) * tickSize;
        // Ensure TP is greater than the current price
        if (tpPriceRounded <= entryPrice) {
            throw new Error(`Take Profit price (${tpPriceRounded}) must be greater than current price (${entryPrice}).`);
        }

        // Ensure SL is less than the current price
        if (slPriceRounded >= entryPrice) {
            throw new Error(`Stop Loss price (${slPriceRounded}) must be less than current price (${entryPrice}).`);
        }

        const order = await placeFuturesOrder(symbol, 'BUY', quantity, leverage, slPriceRounded, tpPriceRounded);  // Place BUY order


        console.log(`Entry Price: ${entryPrice}, Stop-Loss: ${slPriceRounded}, Take-Profit: ${tpPriceRounded}`);

        // Monitor the position for SL/TP hit
        await monitorPosition(symbol, entryPrice, 'BUY', slPriceRounded, tpPriceRounded, quantity);

    } else if (shortMA < longMA && currentPrice < shortMA) {
        console.log('Sell signal detected.');
        const entryPrice = currentPrice;
        const slPrice = entryPrice * (1 + slMultiplier); // Stop-Loss 2% below entry price
        const tpPrice = entryPrice * (1 - tpMultiplier); // Take-Profit 5% above entry price

        // Round to nearest tick size
        const slPriceRounded = Math.floor(slPrice / tickSize) * tickSize;
        //const tpPriceRounded = Math.ceil(tpPrice / tickSize) * tickSize;
        const tpPriceRounded = Math.floor(tpPrice / tickSize) * tickSize;
        // Ensure TP is greater than the current price
        if (tpPriceRounded <= entryPrice) {
            console.warn(`${symbol} of Take Profit price (${tpPriceRounded}) must be greater than current price (${entryPrice}).`);
            throw new Error(`Take Profit price (${tpPriceRounded}) must be greater than current price (${entryPrice}).`);
        }

        // Ensure SL is less than the current price
        if (slPriceRounded >= entryPrice) {
            throw new Error(`Stop Loss price (${slPriceRounded}) must be less than current price (${entryPrice}).`);
        }

        const order = await placeFuturesOrder(symbol, 'SELL', quantity, leverage, slPriceRounded, tpPriceRounded);  // Place SELL order
        console.log(`Entry Price: ${entryPrice}, Stop-Loss: ${slPriceRounded}, Take-Profit: ${tpPriceRounded}`);

        // Monitor the position for SL/TP hit
        await monitorPosition(symbol, entryPrice, 'SELL', slPriceRounded, tpPriceRounded, quantity);
    } else {
        console.log('No trade signal.');
    }
}
console.log("Robot started ");

// Execute the strategy every minute
setInterval(() => {
    // Example: Execute the moving average strategy with 10x leverage on BTCUSDT
    movingAverageStrategy('BTCUSDT', 10);
    movingAverageStrategy('ETHUSDT', 10);
}, 60000);  // Runs every minute
