# 🦅 Bot Trading Cazador (Binance Spot)

Bot algorítmico autónomo para **Binance Spot** con estrategia multi-moneda de compra en caídas (Buy the Dip) y toma de ganancias garantizada mediante órdenes nativas en el exchange.

---

## 🚀 Características Principales

* **Estrategia Cazador Multi-Moneda:** Escanea continuamente los pares de mayor liquidez (`BTC`, `ETH`, `SOL`, `BNB`, `AVAX`, `ADA`, `XRP`) en busca de sobreventas extremas (RSI bajo y zonas de soporte).
* **Cero Riesgo de Liquidación:** Opera exclusivamente en mercado **Spot** (sin apalancamiento, sin margen ni futuros).
* **Órdenes Blindadas en Binance:** Las ventas se colocan inmediatamente como órdenes `LIMIT SELL` oficiales en el exchange; la venta se ejecuta incluso si la computadora se apaga.
* **Auto-Compounding:** Reinversión automática de las ganancias ciclo tras ciclo.
* **Alertas y Control por Telegram:** Notificaciones en tiempo real al celular de compras, ventas y comandos interactivos (`/estado`, `/reporte`, `/radar`, `/balance`, `/pausa`, `/reanudar`).
* **Seguridad:** Arquitectura sin permisos de retiro, con claves aisladas en variables de entorno.

---

## 🛠️ Instalación y Uso

1. Clonar el repositorio e instalar dependencias:
   ```bash
   git clone https://github.com/miguelacr94/Bot-Trading-Cazador-.git
   cd Bot-Trading-Cazador-
   npm install
   ```

2. Configurar el archivo `.env` basado en `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. Iniciar el bot en modo unificado:
   ```bash
   npm start
   ```
