/*
  Jenkins declarative pipeline: verify client build, build Docker image, optional push.

  Agent requirements:
  - Docker CLI and daemon for "Verify client build" (docker run node image) and "Docker build".
  - No Docker Pipeline plugin required; stages use plain `docker` commands on agent any.

  Optional image push (CD):
  - Job / folder environment:
      DOCKER_REGISTRY   Full image prefix without image name, e.g. ghcr.io/myorg or docker.io/myuser
  - Credentials (username/password) with ID "docker-registry", or set DOCKER_REGISTRY_CREDS_ID.
  - Push runs only for branches main or master (edit the "when" block to match your workflow).

  Optional flags:
      SKIP_CLIENT_VERIFY = true   # skip npm ci + client build on the agent
      SKIP_DOCKER_PUSH   = true   # never push, even on main/master

  Optional container deploy (after build):
      RUN_DEPLOY = true           # run "Deploy container" stage
  Create two "Secret text" credentials in Jenkins:
      Default IDs: media-streaming-jwt-secret  -> JWT (min 16 chars)
                    media-streaming-admin-initial-password -> bootstrap admin pwd (min 8 chars; ignored if DB already has admin)
  Override credential IDs with:
      JWT_SECRET_CRED_ID
      ADMIN_INITIAL_PASSWORD_CRED_ID
  Optional deploy paths / names (job env):
      DEPLOY_CONTAINER_NAME   default: media-streaming
      DEPLOY_VIDEOS_PATH      host path mounted read-only as /Videos (default: ${WORKSPACE}/Videos)
      DEPLOY_DATA_VOLUME      named Docker volume for SQLite (default: media-streaming-data)
      DEPLOY_HOST_PORT_HTTP   host port for 8020 (default: 8020)
      DEPLOY_HOST_PORT_RTMP   host port for 1935 (default: 1935)
      DEPLOY_SKIP_RM          if "true", do not docker rm -f before run (default: remove old container)
*/

pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timestamps()
    disableConcurrentBuilds(abortPrevious: true)
  }

  environment {
    DOCKER_BUILDKIT = '1'
    IMAGE_NAME = "${env.IMAGE_NAME ?: 'media-streaming'}"
    GIT_SHORT = "${env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : 'nogit'}"
    TAG = "${env.BRANCH_NAME ?: 'unknown'}-${env.BUILD_NUMBER}-${GIT_SHORT}"
    LOCAL_IMAGE = "${IMAGE_NAME}:${TAG}"
    REGISTRY_CREDS = "${env.DOCKER_REGISTRY_CREDS_ID ?: 'docker-registry'}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Verify client build') {
      when {
        expression { return env.SKIP_CLIENT_VERIFY != 'true' }
      }
      steps {
        sh """
          set -e
          docker run --rm \\
            -v "${env.WORKSPACE}:/ws" \\
            -w /ws/client \\
            node:20-bookworm-slim \\
            bash -lc 'npm ci && npm run build'
        """
      }
    }

    stage('Docker build') {
      steps {
        sh "docker build -t ${env.LOCAL_IMAGE} ."
        sh "docker tag ${env.LOCAL_IMAGE} ${env.IMAGE_NAME}:latest"
      }
    }

    stage('Docker push') {
      when {
        allOf {
          expression { env.SKIP_DOCKER_PUSH != 'true' }
          expression { env.DOCKER_REGISTRY?.trim() }
          anyOf {
            branch 'main'
            branch 'master'
          }
        }
      }
      steps {
        script {
          def remoteImage = "${env.DOCKER_REGISTRY}/${env.IMAGE_NAME}"
          withCredentials([
            usernamePassword(
              credentialsId: env.REGISTRY_CREDS,
              usernameVariable: 'DOCKER_USER',
              passwordVariable: 'DOCKER_PASS',
            ),
          ]) {
            sh """
              set -e
              REMOTE='${remoteImage}'
              TAG='${env.TAG}'
              LOCAL='${env.LOCAL_IMAGE}'
              LOGIN_HOST="\${DOCKER_LOGIN_HOST:-\$(echo -n '${env.DOCKER_REGISTRY}' | cut -d/ -f1)}"
              docker tag "\$LOCAL" "\$REMOTE:\$TAG"
              docker tag "\$LOCAL" "\$REMOTE:latest"
              echo "\$DOCKER_PASS" | docker login "\$LOGIN_HOST" -u "\$DOCKER_USER" --password-stdin
              docker push "\$REMOTE:\$TAG"
              docker push "\$REMOTE:latest"
            """
          }
        }
      }
    }

    stage('Deploy container') {
      when {
        expression { env.RUN_DEPLOY == 'true' }
      }
      steps {
        script {
          def jwtCredId = env.JWT_SECRET_CRED_ID ?: 'media-streaming-jwt-secret'
          def adminCredId = env.ADMIN_INITIAL_PASSWORD_CRED_ID ?: 'media-streaming-admin-initial-password'
          def cname = env.DEPLOY_CONTAINER_NAME ?: 'media-streaming'
          def videosPath = env.DEPLOY_VIDEOS_PATH ?: "${env.WORKSPACE}/Videos"
          def dataVol = env.DEPLOY_DATA_VOLUME ?: 'media-streaming-data'
          def pHttp = env.DEPLOY_HOST_PORT_HTTP ?: '8020'
          def pRtmp = env.DEPLOY_HOST_PORT_RTMP ?: '1935'
          def img = "${env.IMAGE_NAME}:latest"
          withCredentials([
            string(credentialsId: jwtCredId, variable: 'JWT_SECRET'),
            string(credentialsId: adminCredId, variable: 'ADMIN_INITIAL_PASSWORD'),
          ]) {
            if (env.DEPLOY_SKIP_RM != 'true') {
              sh "docker rm -f ${cname} 2>/dev/null || true"
            }
            sh """
              set -e
              docker volume create ${dataVol} 2>/dev/null || true
              docker run -d --name ${cname} --restart unless-stopped \\
                -e JWT_SECRET="\$JWT_SECRET" \\
                -e ADMIN_INITIAL_PASSWORD="\$ADMIN_INITIAL_PASSWORD" \\
                -p ${pHttp}:8020 \\
                -p ${pRtmp}:1935 \\
                -v "${videosPath}:/Videos:ro" \\
                -v ${dataVol}:/data \\
                ${img}
            """
          }
        }
      }
    }
  }

  post {
    success {
      echo "Built image: ${env.LOCAL_IMAGE} (also ${env.IMAGE_NAME}:latest)"
    }
  }
}
