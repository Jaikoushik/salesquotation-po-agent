const { Pool } = require("pg");
var vcap_services = JSON.parse(process.env.VCAP_SERVICES);
/*
console.log("VCAP",JSON.stringify(vcap_services))
console.log(JSON.stringify(vcap_services["postgresql-db"]))
console.log(JSON.stringify(vcap_services["postgresql-db"][0]));
console.log(JSON.stringify(vcap_services["postgresql-db"][0]["credentials"]));
*/
const dburl = vcap_services["postgresql-db"][0]["credentials"];

//console.log("Database URL:",dburl);
const pool = new Pool({
    user: dburl.username,
    host: dburl.hostname,
    database: dburl.dbname,
    port: dburl.port,
    password: dburl.password,
    ssl: {
        require: true,
        rejectUnauthorized: false
    }
});

module.exports = { pool };