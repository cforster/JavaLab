var connect = require('connect');
var path = require('path');

var server = connect()
  .use(connect.favicon())
  .use('/', connect.static(path.join(__dirname, 'static')));

var http_server = require('http').createServer(server);
// TODO: is this hack still needed?
http_server.use = function() { server.use.apply(server, arguments); }

require('./labserver').attach(http_server);

var options = {
  staticpath: '/share',
  db: {type: 'mongo'},
  browserChannel: null,
  websocket: {prefix: '/shareserver'}
};
require('share').server.attach(http_server, options);

var port = process.env.npm_package_config_port || 80;
http_server.listen(port);
