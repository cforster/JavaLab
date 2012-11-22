function LabCtrl($scope) {
  $scope.user = '';
  $scope.labs = [];
  $scope.lab = null;
  $scope.servermsg = 'disconnected';

  var socket = new WebSocket('ws://' + document.location.host + '/labserver');
  socket.onopen = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = 'idle';
    });
  }
  socket.onmessage = function(event) {
    $scope.$apply(function() {
      var r = JSON.parse(event.data);
      switch (r.type) {
      case 'error':
        console.log(r.text);
        break;
      case 'state':
        $scope.servermsg = r.state;
        if (r.state == 'run') {
          clearTerm();
          $('#footertabs a[href="#output-tab"]').tab('show');
          $scope.errors = [];
          $scope.selectedError = null
        }
        break;
      case 'updateLabs':
        $scope.labs = r.labs;
        if (!$scope.lab) {
          $scope.lab = $scope.labs[0] || null;
        }
        break;
      case 'updateLabParts':
        $scope.parts = [];
        for (var i = 0; i < r.labParts.length; i++) {
          $scope.parts.push(r.labParts[i]);
        }
        if ($scope.activePart) {
          var activePartIndex = r.labParts.indexOf($scope.activePart);
          if (activePartIndex != -1) {
            $scope.switchPart($scope.parts[activePartIndex]);
          } else {
            $scope.switchPart($scope.parts[0] || null);
          }
        } else {
          $scope.switchPart($scope.parts[0] || null);
        }
        break;
      case 'compileErrors':
        $scope.errors = r.compileErrors;
        $scope.selectedError = $scope.errors[0] || null;
        $('#footertabs a[href="#errors-tab"]').tab('show');
        $scope.onErrorSelect();
        break;
      case 'stdout':
        termStdout(r.stdout);
        break;
      }
    });
  }
  socket.onerror = socket.onclose = function(event) {
    console.log(event);
    $scope.$apply(function() {
      $scope.servermsg = 'disconnected';
      $scope.editor.setReadOnly(true);
    });
  }

  $scope.errors = [];
  $scope.selectedError = null;
  $scope.onErrorSelect = function() {
    if ($scope.selectedError) {
      $scope.editor.gotoLine($scope.selectedError.line,
                             $scope.selectedError.col);
    }
  }

  $scope.newPartNameChanged = function() {
    if (!$scope.newPartPattern.exec($scope.newPartName)) {
      $scope.newPartForm.$invalid = true;
      return;
    }
    if ($scope.parts.indexOf($scope.newPartName) != -1) {
      $scope.newPartForm.$invalid = true;
      return;
    }
    $scope.newPartForm.$invalid = false;
  }

  $scope.newPartPattern = /^[A-Za-z0-9]*$/;
  $scope.parts = [];
  $scope.activePart = null;

  var shareConnection = new sharejs.Connection(
    'ws://' + document.location.host + '/shareserver');
  var openDoc = null;
  $scope.switchPart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    if (part && openDoc && $scope.activePart &&
        $scope.activePart == part) {
      return;
    }
    $scope.errors = [];
    $scope.selectedError = null;
    $scope.activePart = part;

    if (openDoc) {
      openDoc.detach_ace();
      // TODO: closing sharejs docs prevents them from ever being re-opened
      // revisit closing docs here if sharejs is fixed
      openDoc = null;
      $scope.editor.setReadOnly(true);
    }

    if (part != null) {
      $scope.editor.setValue('Loading...');
      shareConnection.open(
        $scope.user + ':' + $scope.lab + ':' + part,
        'text',
        function(e, doc) {
          if (e) return console.log(e);
          if (doc.state != 'open')
            console.log('Opened doc ' + doc.name + ' has state ' + doc.state);
          if (part != $scope.activePart) {
            // another doc became active while this doc was opening
            return;
          }
          openDoc = doc;
          doc.attach_ace($scope.editor);
          $scope.editor.gotoLine(1, 0, false);
          $scope.editor.scrollToRow(0);
          $scope.editor.setReadOnly(false);
        });
    } else {
      $scope.editor.setValue('No part selected');
    }
  }

  $scope.removePart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'deleteLabPart', partName: part}));
    var i = $scope.parts.indexOf(part);
    $scope.parts.splice(i, 1);
    if ($scope.activePart == part) {
      if (i == $scope.parts.length) i--;
      $scope.switchPart($scope.parts.length == 0 ? null : $scope.parts[i]);
    }
  }

  $scope.newPart = function() {
    $scope.newPartNameChanged();
    if (!$scope.user || socket.readyState != 1) return;
    if ($scope.newPartForm.$invalid || !$scope.newPartName)
      return;

    var unique = true;
    angular.forEach($scope.parts, function(part) {
      if (part == $scope.newPartName) unique = false;
    });
    if (!unique) {
      $scope.newPartName = '';
      return;
    }

    var newPart = $scope.newPartName;
    $scope.newPartName = '';
    $scope.parts.push(newPart);
    $scope.switchPart(newPart);
    socket.send(JSON.stringify({type: 'addLabPart', partName: newPart}));
  }

  $scope.switchLab = function() {
    $scope.lastUser = $scope.user;
    $('#loginModal').modal();
  }

  $scope.login = function() {
    if (!$scope.user) return;
    $('#loginModal').modal('hide');
  }

  $('#loginModal').on('hidden', function() {
    $scope.$apply(function() {
      if (!$scope.user) {
        if ($scope.lastUser) {
          $scope.user = $scope.lastUser;
        }
        return;
      }
      socket.send(JSON.stringify({type: 'setUser', user: $scope.user}));
      socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
    });
  });

  $scope.run = function() {
    if (!$scope.user || socket.readyState != 1) return;
    var src = $scope.editor.getValue();
    socket.send(JSON.stringify({type: 'compileRun', src: src}));
  }

  $scope.stop = function() {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'stop'}));
  }

  $scope.initEditor = function() {
    $scope.editor = ace.edit('editor');
    $scope.editor.setTheme('ace/theme/chrome');
    $scope.editor.getSession().setMode('ace/mode/java');
    $scope.editor.setPrintMarginColumn(100);
    $scope.editor.getSession().setUseSoftTabs(true);
    $scope.editor.getSession().setTabSize(2);
    $scope.editor.setValue('No part loaded');
    $scope.editor.setReadOnly(true);
  }

  var termStdinStart = 0;
  function clearTerm() {
    var term = $('#terminal')[0];
    term.value = '';
    termStdinStart = 0;
  }
  function termStdout(stdoutData) {
    var term = $('#terminal')[0];
    var stdinData = '';
    if (term.value.length > termStdinStart) {
      stdinData = term.value.substr(termStdinStart);
      term.value = term.value.substring(0, termStdinStart);
    }
    term.value += stdoutData;
    termStdinStart += stdoutData.length;
    if (stdinData) {
      term.value += stdinData;
    }
    term.scrollTop = term.scrollHeight;
  }
  $scope.initTerminal = function() {
    clearTerm();
    var term = $('#terminal')[0];
    $('#terminal').keydown(function(event) {
      handlers = {
        8: function() {  // backspace
          if (term.selectionStart <= termStdinStart) {
            event.preventDefault();
          }
        },
        46: function() {  // delete
          if (term.selectionStart < termStdinStart) {
            event.preventDefault();
          }
        },
        13: function() {  // newline
          if (term.selectionStart == term.value.length) {
            term.value += '\n';
            var stdinData = term.value.substr(termStdinStart);
            termStdinStart = term.value.length;
            if (socket.readyState == 1) {
              socket.send(JSON.stringify({type: 'stdin', stdin: stdinData}));
            }
            term.scrollTop = term.scrollHeight;
          }
          event.preventDefault();
        }
      };
      if (event.which in handlers) {
        if ($scope.servermsg != 'run') {
          event.preventDefault();
        } else {
          handlers[event.which]();
        }
      }
    });
    $('#terminal').keypress(function(event) {
      if (event.which > 31 && event.which < 127) {
        if ($scope.servermsg != 'run' ||
            term.selectionStart < termStdinStart) {
          event.preventDefault();
        }
      }
    });
    $('#terminal').bind('cut', function(event) {
      if (term.selectionStart < termStdinStart)
        event.preventDefault();
    });
    $('#terminal').bind('paste', function(event) {
      if (term.selectionStart < termStdinStart)
        event.preventDefault();
    });
  }

  $(window).load(function() {
    // allow user to resize tabs
    (function() {
      var startY = null;
      $('#footerhandle').mousedown(function(event) {
        event.preventDefault();
        startY = event.clientY;
        $('html').addClass('ns-resize');
      });
      $(window).mousemove(function(event) {
        if (startY) {
          var delta = startY - event.clientY;
          if (delta < 0 && $('#footer').height() < 150) return;
          if (delta > 0 && $('#content').height() < 150) return;
          $('#footer').css('height', '+=' + delta);
          $('#content').css('bottom', '+=' + delta);
          startY = event.clientY;
          $scope.editor.resize(true);
        }
      });
      $(window).mouseup(function(event) {
        if (startY) {
          startY = null;
          $('html').removeClass('ns-resize');
        }
      });
    }());

    // show the login modal dialog on startup
    $('#loginModal').modal();
  });
}