// @ts-expect-error
import { uniq } from "lodash"
import Dinero, { type Currency, Dinero as Money } from "dinero.js"
import { readFileSync } from "fs"
import Papa from "papaparse"

type ISIN = string

type NordnetRow = {
  Id: string
  Bokføringsdag: string
  Handelsdag: string
  Oppgjørsdag: string
  Portefølje: string
  Transaksjonstype: string
  Verdipapir: string
  "Type verdipapir": string
  ISIN: ISIN
  Antall: string
  Kurs: string
  Rente: string
  "Totale Avgifter": string
  Valuta: Currency
  Beløp: string
  // Valuta: string
  Kjøpsverdi: string
  // Valuta: string
  Resultat: string
  // Valuta: string
  "Totalt antall": string
  Saldo: string
  Vekslingskurs: string
  Transaksjonstekst: string
  Makuleringsdato: string
  Sluttseddelnummer: string
  Verifikationsnummer: string
  Kurtasje: string
  // Valuta: string
}

const readable = process.stdin.setEncoding("utf16le")

let chunks: string[] = []

readable.on("readable", () => {
  let chunk
  while (null !== (chunk = readable.read())) {
    chunks.push(chunk)
  }
})

readable.on("end", () => {
  const content = chunks.join("")

  const result = Papa.parse<NordnetRow>(content, {
    header: true,
  })

  interface Purchase {
    isin: string
    ticker: string
    quantity: Money
    price: Money
    dateIso8601: string
  }

  const stocksPurchased: Record<ISIN, Purchase[]> = {}

  result.data.forEach((row) => {
    switch (row.Transaksjonstype) {
      case "KJØPT":
      case "KJØP, BYTTE AV FOND":
        const ticker = row.Verdipapir
        const isin = row.ISIN
        const quantity = Dinero({
          amount: Math.round(
            parseFloat(row.Antall.replace(/[^0-9,.]/, "").replace(/,/, ".")) *
              10000
          ),
          currency: row.Valuta,
          precision: 4,
        })
        const price = Dinero({
          amount: Math.round(
            parseFloat(row.Kurs.replace(/[^0-9,.]/, "").replace(/,/, ".")) *
              1000
          ),
          currency: row.Valuta,
          precision: 3,
        })
        const dateIso8601 = row.Handelsdag
        const purchases = stocksPurchased[isin] || []
        stocksPurchased[isin] = purchases.concat({
          isin,
          ticker,
          quantity,
          price,
          dateIso8601,
        })
        break
    }
  })

  // Sort by date
  Object.keys(stocksPurchased).forEach((isin) => {
    stocksPurchased[isin] = stocksPurchased[isin].sort((a, b) => {
      return (
        new Date(a.dateIso8601).getTime() - new Date(b.dateIso8601).getTime()
      )
    })
  })

  const TYPES = ["SALG", "SALG, BYTTE AV FOND"]

  const orderedSalesAndSwapsRows = result.data
    .filter((row) => TYPES.includes(row.Transaksjonstype))
    .sort((a, b) => {
      return new Date(a.Handelsdag).getTime() - new Date(b.Handelsdag).getTime()
    })

  interface Sale extends Purchase {
    salePrice: Money
    soldDateIso8601: string
  }

  // Process sales
  const stocksSold: Record<ISIN, Sale[]> = {}

  for (let i = 0; i < orderedSalesAndSwapsRows.length; i++) {
    const row = orderedSalesAndSwapsRows[i]

    const salePrice: Money = Dinero({
      amount: Math.round(
        parseFloat(row.Kurs.replace(/[^0-9,.]/, "").replace(/,/, ".")) * 1000
      ),
      currency: row.Valuta,
      precision: 3,
    })
    let saleQuantity = Dinero({
      amount: Math.round(
        parseFloat(row.Antall.replace(/[^0-9,.]/, "").replace(/,/, ".")) * 10000
      ),
      currency: row.Valuta,
      precision: 4,
    })
    let selling = true

    while (selling) {
      const ticker = row.Verdipapir
      const isin = row.ISIN
      const purchase = stocksPurchased[isin]?.[0]
      if (!purchase) {
        console.error(
          `Unable to find purchase when calculating sale of ${ticker}. Skipping.`
        )
        selling = false
        break
      }

      const saleDateIso8601 = row.Handelsdag
      const sale = {
        ...purchase,
        salePrice: salePrice,
        soldDateIso8601: saleDateIso8601,
      }

      const quantity = Dinero.minimum([saleQuantity, purchase.quantity])
      purchase.quantity = purchase.quantity.subtract(quantity)
      saleQuantity = saleQuantity.subtract(quantity)

      if (purchase.quantity.isZero()) {
        stocksPurchased[isin].shift()
      }

      stocksSold[isin] = stocksSold[isin] || []
      stocksSold[isin].push(sale)

      if (saleQuantity.isZero()) selling = false
    }
  }

  const soldAndBought = [
    Object.values(stocksPurchased),
    Object.values(stocksSold),
  ].flat(3)
  soldAndBought.sort((a, b) => {
    return new Date(a.dateIso8601).getTime() - new Date(b.dateIso8601).getTime()
  })

  const header = [
    "#",
    "ISIN",
    "Ticker",
    "Purchase date",
    "Amount",
    "Price",
    "Quantity",
    "Sale date",
    "Sale price",
    "Profit/loss",
  ].join(",")

  console.log(header)

  soldAndBought.forEach((data, i) => {
    const purchaseAmount = data.price
      .multiply(data.quantity.getAmount())
      .divide(10000)
    const row: string[] = [
      i.toString(),
      data.isin,
      data.ticker,
      data.dateIso8601,
      purchaseAmount.toFormat("$0.000"),
      data.price.toFormat("$0.000"),
      data.quantity.toFormat("0.000"),
    ]
    if ("soldDateIso8601" in data) {
      let sale = data as Sale
      const profit = sale.salePrice
        .subtract(sale.price)
        .multiply(data.quantity.getAmount())
        .divide(10000)
      row.push(
        sale.soldDateIso8601,
        sale.salePrice.toFormat("$0.000"),
        profit.toFormat("$0.00")
      )
    } else {
      row.push("", "", "")
    }
    console.log(row.map((col) => `"${col}"`).join(","))
  })
})
