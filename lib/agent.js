var fs   = require('fs'),
exec = require('child_process').exec,
path = require('path'),
os   = require('os'),
util = require('util'),
yaml = require('js-yaml');

var redis = require("redis"),
_     = require("underscore"),
async = require("async");

String.prototype.trim = function() {
    return this.replace(/^\s+|\s+$/g, "");
};

function randomNumber(low, high) {
    return Math.floor(Math.random() * (high - low) + low);
}

function Agent(config){
  if(!_.isObject(config)){
    return console.error("Bad config");
  }

  this.nutcracker_config_file = config.nutcracker_config_file;
  this.redis_sentinel_port    = config.redis_sentinel_port;
  this.restart_command        = config.restart_command;
  this.conn_retry_count       = 0;
  this.log_file		      = config.log_file;

  // Get list of sentinel ips
  this.redis_sentinel_ips = JSON.parse(fs.readFileSync(config.redis_sentinel_ip_file, 'utf8'));
}

// Logs a message to the console and to the file
// specifid in the cli.js
Agent.prototype.log = function (message) {
  var theDate = new Date(),
  hour = theDate.getHours().toString(),
  min = theDate.getMinutes().toString(),
  sec = theDate.getSeconds().toString();

  hour = (hour.length != 1) ? hour : "0" + hour;
  min  = (min.length != 1) ? min : "0" + min;
  sec  = (sec.length != 1) ? sec : "0" + sec;

  var theMessage = "[" + hour + ":" + min + ":" + sec + "] " + message;
  util.puts(theMessage);

  if(this.log_file != undefined) {
   fs.appendFile(this.log_file, theMessage + '\n', function(err) {

   });
 };
};

// Restarts TwemProxy
Agent.prototype.restart_twemproxy = function(callback){
  var self = this;
  var child = exec(
    this.restart_command,
    function(error, stdout, stderr) {
      self.log("TwemProxy restarted with output: ");
      self.log(stdout);
      if (error !== null) {
        self.log("TwemProxy failed restarting with error: " + error);
      }

      return callback();
    }
    );
};

// Updates the address of a server, by its name, in the TwemProxy config
Agent.prototype.update_master_address = function(server, address) {
  this.log("Updating Master " + server + " to " + address);
  var found = false;
  _.each(this.doc, function(proxy_data, proxy_name) {
    _.each(proxy_data.servers, function(server_entry, server_idx) {
      // we need to get the server name from the config value
      var conf_name = _.last(server_entry.split(' '));
      if(conf_name == server) {
        // We've found the matching server
        proxy_data.servers[server_idx] = address + ":1 " + server;
        found = true;
      };
    });
  });
  if (!found) {
    this.log("WARNING: Update Failed! Server " + server + " not found in TwemProxy config!");
  }
};

// The handler for the master-switch event from Redis Sentinel
Agent.prototype.switch_master_handler = function(){
  var self = this;

  return function(data) {
    self.log("Received switch-master: " + util.inspect(data));

    self.update_master_address(data.details["master-name"], data.details["new-ip"]+":"+data.details["new-port"]);

    async.series([
      function(callback) { self.save_twemproxy_config(callback); },
      function(callback) { self.restart_twemproxy(callback); }
      ]);
  };
};

// Loads the TwemProxy config file from disk
Agent.prototype.load_twemproxy_config = function(callback){
  this.log("Loading TwemProxy config");
  try {
    this.doc = yaml.safeLoad(fs.readFileSync(this.nutcracker_config_file, 'utf8'));
    callback();
  } catch (e) {
    return callback(e);
  }
};

// Saves the TwemProxy config file to disk
Agent.prototype.save_twemproxy_config = function(callback){
  this.log("Saving TwemProxy config");
  fs.writeFile(this.nutcracker_config_file, yaml.safeDump(this.doc), callback);
};

// This will connect to Redis Sentinel and get a list of all current
// master servers, and ensure our config is full up to date
Agent.prototype.force_master_update = function() {
  var self = this;
  self.log("Getting latest list of masters...");

  // Get the masters list
  this.client.send_command("SENTINEL", ["masters"], function (err, reply) {

    for (var i = 0; i < reply.length; i++) {
      var server = reply[i][1];
      var address = reply[i][3] + ":" + reply[i][5];

      self.log("Master received: " + server + " " + address);
      // Set the IP and Port on the document
      self.update_master_address(server, address);
    }

    async.series([
      function(callback) { self.save_twemproxy_config(callback); },
      function(callback) { self.restart_twemproxy(callback); }
      ]);

  });
};

// This pings the Sentinel
Agent.prototype.ping_sentinel = function(callback) {
  var self = this;
  self.log("Pinging sentinel (health check)...");

  // Get the masters list
  this.clientHealthCheck.send_command("PING", [], function (err, reply) {
    if (reply.trim() == "PONG") {
      callback();
    } else {
      console.log("Health check FAILURE!!! UNABLE TO PING SENTINEL");
      process.exit(1);
    }
  });
};

// Starts the pub/sub monitor on Sentinel
Agent.prototype.start_sentinel = function(){

  this.log("Redis Sentinel TwemProxy Agent Started on: " + (new Date()).toString());
  var handler = this.switch_master_handler();
  var self = this;
  
  this.randomSentinelIP = rand(self.redis_sentinel_ips);
  this.client = randSentinel(this.randomSentinelIP, self.redis_sentinel_port);

  this.client.on("error", function(msg) {
    if (msg.toString().indexOf("ECONNREFUSED") == -1) {
      self.log("Redis TwemProxy Agent encountered an error: ");
      self.log(msg);
    } else {
      self.conn_retry_count = self.conn_retry_count + 1;
      if (self.conn_retry_count % 10 == 0) {
        self.log("WARNING: Connection to Redis Sentinel has failed " + self.conn_retry_count + " times!");
        // Try to connect to another client
        this.randomSentinelIP = rand(self.redis_sentinel_ips);
        this.client = randSentinel(this.randomSentinelIP, self.redis_sentinel_port);
      };
    };
  });

  this.client.on("end", function() {
    self.log("Error: Connection to Redis Sentinel was closed!");
    process.exit(1);
  });

  this.client.on("connect", function() {
    self.log("Connection to Redis Sentinel established.")
    // Here we need to check the master-list and ensure it matches our config
    // We have to create a new connection to redis which isn't in pub/sub mode to do this

    // Update list of masters
    self.force_master_update();

    // Subscribe to a sentinel
    self.log("Subscribing to sentinel.");

    self.client.on("pmessage", function (p, ch, msg) {
      var aux = msg.split(' '),
      ret =  {
        'master-name': aux[0],
        'old-ip': aux[1],
        'old-port': aux[2],
        'new-ip': aux[3],
        'new-port': aux[4]
      };

      handler({details: ret});
    });

      self.client.psubscribe('+switch-master');

    // Initiate client health check
    self.log("Health Check starting")
    self.clientHealthCheck = randSentinel(self.randomSentinelIP, self.redis_sentinel_port);

    self.clientHealthCheck.on("error", function(msg) {
      if (msg.toString().indexOf("ECONNREFUSED") == -1) {
        self.log("Error: Health Check connection refused!");
        process.exit(1);
      } else {
        self.log("Error: Health Check misc. connection error!");
        process.exit(1);
      };
    });

    self.clientHealthCheck.on("end", function() {
      self.log("Error: Health Check connection to Redis Sentinel was closed!");
      process.exit(1);
    });

    self.clientHealthCheck.on("connect", function() {
      self.log("Health Check: Connection to Redis Sentinel established.");
      
      // Ping server
      var baseTime = 60; // seconds
      var jitter = 120; // seconds
      (function timerWithJitter() {
          var rand = (baseTime + randomNumber(0,jitter)) * 1000; // millis
          setTimeout(function() {
            self.ping_sentinel( function() { 
              timerWithJitter();  
            });
          }, rand);
      }());

    });    

  });
};

// Initialisation
Agent.prototype.bootstrap = function(){
  var self = this;

  this.load_twemproxy_config(
    function(error){
      if(error) {
        return console.error(error);
      }

      return self.start_sentinel();
    }
    );
};

// Initialisation
Agent.bootstrap = function (config) {
  (new Agent(config)).bootstrap();
};

function rand(items){
  return items[~~(Math.random() * items.length)];
}

function randSentinel(randomSentinelIP, redis_sentinel_port){
  console.log("Attempting to connect to random sentinel: " + randomSentinelIP + ":" + redis_sentinel_port);
  return redis.createClient(
    redis_sentinel_port,
    randomSentinelIP,
    {
      retry_max_delay: 5000,
      socket_keepalive: true
    });
}

module.exports = Agent;
