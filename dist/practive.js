const transactions = [
    { id: 1, amount: 500, status: "approved" },
    { id: 2, amount: 300, status: "pending" },
    { id: 3, amount: 800, status: "approved" },
    { id: 4, amount: 200, status: "rejected" },
];
const result = {
    approved: transactions.filter((transaction) => transaction.status === "approved"),
};
console.log(result);
export {};
