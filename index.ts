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

interface Purchase {
  isin: string
  ticker: string
  totalPrice: Money
  quantity: number
  price: Money
  dateIso8601: string
}

interface Sale extends Purchase {
  salePrice: Money
  soldDateIso8601: string
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

  const stocksPurchased: Record<ISIN, Purchase[]> = {}

  result.data.forEach((row) => {
    switch (row.Transaksjonstype) {
      case "KJØPT":
      case "KJØP, BYTTE AV FOND":
        const ticker = row.Verdipapir
        const isin = row.ISIN
        const totalPrice = Dinero({
          amount: Math.round(
            parseFloat(row.Beløp.replace(/[^0-9,.]/g, "").replace(/,/, ".")) * 100
          ),
          currency: row.Valuta,
          precision: 2,
        })
        const quantity = Math.round(
          parseFloat(row.Antall.replace(/[^0-9,.]/g, "").replace(/,/, ".")) *
            10000
        )
        const price = totalPrice
          .convertPrecision(4)
          .multiply(10000)
          .divide(quantity)
        const dateIso8601 = row.Handelsdag
        const purchases = stocksPurchased[isin] || []
        stocksPurchased[isin] = purchases.concat({
          isin,
          ticker,
          quantity,
          totalPrice,
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

  // Process sales
  const stocksSold: Record<ISIN, Sale[]> = {}

  for (let i = 0; i < orderedSalesAndSwapsRows.length; i++) {
    const row = orderedSalesAndSwapsRows[i]

    const totalSalePrice: Money = Dinero({
      amount: Math.round(
        parseFloat(row.Beløp.replace(/[^0-9,.]/g, "").replace(/,/, ".")) * 100
      ),
      currency: row.Valuta,
      precision: 2,
    })
    let saleQuantity = Math.round(
      parseFloat(row.Antall.replace(/[^0-9,.]/g, "").replace(/,/, ".")) * 10000
    )
    const salePrice = totalSalePrice.convertPrecision(4).multiply(10000).divide(saleQuantity)
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

      const quantity = Math.min(saleQuantity, purchase.quantity)

      const saleDateIso8601 = row.Handelsdag
      const sale = {
        ...purchase,
        totalPrice: purchase.price.convertPrecision(4).multiply(quantity).divide(10000),
        salePrice: salePrice,
        soldDateIso8601: saleDateIso8601,
      }

      purchase.quantity -= quantity
      saleQuantity -= quantity

      if (purchase.quantity === 0) {
        stocksPurchased[isin].shift()
      } else {
        purchase.totalPrice = purchase.totalPrice.subtract(purchase.price.convertPrecision(4).multiply(quantity).divide(10000))
      }

      stocksSold[isin] = stocksSold[isin] || []
      stocksSold[isin].push(sale)

      if (saleQuantity === 0) selling = false
    }
  }

  const soldAndBought = [
    Object.values(stocksSold),
    Object.values(stocksPurchased),
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

  process.stdout.write(header + "\n")

  soldAndBought.forEach((data, i) => {
    const row: string[] = [
      i.toString(),
      data.isin,
      data.ticker,
      data.dateIso8601,
      data.totalPrice.toFormat("$0.00"),
      data.price.toFormat("$0.000"),
      (data.quantity / 10000).toString(),
    ]
    if ("soldDateIso8601" in data) {
      let sale = data as Sale
      const profit = sale.salePrice
        .subtract(sale.price)
        .multiply(data.quantity)
        .divide(10000)
      row.push(
        sale.soldDateIso8601,
        sale.salePrice.toFormat("$0.000"),
        profit.toFormat("$0.00")
      )
    } else {
      row.push("", "", "")
    }
    process.stdout.write(row.map((col) => `"${col}"`).join(","))
    process.stdout.write("\n")
  })
})
